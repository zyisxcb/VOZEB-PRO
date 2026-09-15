import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import type { DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { createDramaProjectVersionForUser, getDramaProjectForUser, updateDramaProjectForUser } from "@/lib/server/drama-project-service";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { isStructuredTextFailure, rankTextPlanningCandidates, requestStructuredText, type TextPlanningCandidate, type TextPlanningCall, type TextPlanningTool } from "@/lib/server/text-planning-runtime";

const SCRIPT_TOOL: TextPlanningTool = {
    name: "generate_drama_script",
    description: "根据项目故事简介、人物设定、前一集连续性账本生成一集约 60 秒的漫剧剧本和后续衔接摘要",
    parameters: {
        type: "object",
        additionalProperties: false,
        required: ["script", "storyText", "outline", "hook", "nextPreview", "continuitySummary"],
        properties: {
            script: { type: "string", description: "严格按镜号、画面描述、台词/旁白、音效/背景音乐、单镜时长输出的完整本集剧本" },
            storyText: { type: "string", description: "包含对白的完整故事文字，不添加解释" },
            outline: { type: "string", description: "本集发生的主要事件" },
            hook: { type: "string", description: "开篇前三秒的强看点" },
            nextPreview: { type: "string", description: "结尾悬念和下一集承接点" },
            continuitySummary: { type: "string", description: "供下一集使用的压缩连续性账本，只保留已发生事实、人物状态与关系、未解决线索、结尾状态和下一集承接点，禁止复述完整剧本" },
        },
    },
};

export type GeneratedDramaScript = {
    script: string;
    storyText: string;
    outline: string;
    hook: string;
    nextPreview: string;
    continuitySummary: string;
};

export class DramaScriptGenerationError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
    }
}

type GenerationInput = Parameters<typeof generateDramaEpisodeScriptForUser>[0] & {
    model: string;
    candidate: TextPlanningCandidate;
    context: ReturnType<typeof buildGenerationContext>;
};

export async function generateDramaEpisodeScriptForUser(input: { userId: string; projectId: string; episodeId: string; requestId: string; origin: string; cookie: string; signal?: AbortSignal }) {
    const project = await getDramaProjectForUser(input.userId, input.projectId);
    const episode = project.episodes.find((item) => item.id === input.episodeId);
    if (!episode) throw new DramaScriptGenerationError("目标剧集不存在", 404);

    const settings = await getAuthSettings();
    const model = settings.defaultModels.textModel;
    const candidates = rankTextPlanningCandidates(resolveLogicalModelCandidates(settings, "text", model).map((candidate) => ({ ...candidate, channelId: candidate.channel.id })));
    if (!model || !candidates.length) throw new DramaScriptGenerationError("后台尚未配置可用的默认文本模型", 400);

    let latestError: unknown;
    let refundedPointsRemaining: number | undefined;
    for (const candidate of candidates) {
        try {
            const call = await requestGenerationCall({ ...input, model, candidate, context: buildGenerationContext(project, episode, candidate) }, (pointsBalance) => {
                refundedPointsRemaining = pointsBalance;
            });
            const generated = parseGeneratedScript(call.arguments);
            await createDramaProjectVersionForUser(input.userId, project.id, { reason: "AI 剧本生成前", snapshot: project });
            const nextProject = replaceEpisode(project, episode.id, generated);
            const savedProject = await updateDramaProjectForUser(input.userId, project.id, nextProject);
            const savedEpisode = savedProject.episodes.find((item) => item.id === episode.id);
            if (savedEpisode?.script !== generated.script) {
                const refund = await refundCall({ ...input, model, candidate, context: buildGenerationContext(project, episode, candidate) }, call);
                refundedPointsRemaining = refund?.pointsBalance;
                throw new DramaScriptGenerationError("项目在生成期间发生变化，请刷新后重试", 409);
            }
            return { project: savedProject, result: generated, pointsRemaining: readPointsRemaining(call.headers) ?? refundedPointsRemaining };
        } catch (error) {
            latestError = error;
            if (!shouldTryAnotherCandidate(error)) break;
        }
    }
    throw latestError instanceof Error ? latestError : new DramaScriptGenerationError("AI 剧本生成失败");
}

function buildGenerationContext(project: DramaProject, episode: DramaEpisode, candidate: TextPlanningCandidate) {
    const previous = project.episodes.filter((item) => item.id !== episode.id && (item.episodeNumber || 0) < (episode.episodeNumber || 0)).sort((left, right) => (right.episodeNumber || 0) - (left.episodeNumber || 0))[0];
    const configuredWindow = candidate.channel.advancedConfig?.contextWindowTokens;
    const previousContinuity =
        previous?.continuitySummary?.trim() ||
        [previous?.outline ? `上一集大纲：${previous.outline}` : "", previous?.hook ? `上一集开篇看点：${previous.hook}` : "", previous?.nextPreview ? `上一集承接点：${previous.nextPreview}` : ""].filter(Boolean).join("\n") ||
        "无可用的上一集连续性账本，这是本剧的第一集或上一集尚未生成。";
    const ledger = configuredWindow ? previousContinuity.slice(0, Math.floor(configuredWindow * 0.12)) : previousContinuity;
    return {
        project: {
            title: project.title,
            summary: project.summary,
            style: project.style,
            instruction: "项目故事简介同时作为人物设定和故事大纲。只能在此简介范围内塑造人物和推进情节，不要凭空添加与简介冲突的人物背景。",
        },
        targetEpisode: { number: episode.episodeNumber || 1, title: episode.title },
        previousEpisode: previous
            ? {
                  number: previous.episodeNumber || 1,
                  nextPreview: previous.nextPreview,
                  continuitySummary: ledger,
              }
            : null,
        contextPolicy: "只使用上一集的连续性摘要衔接本集，不读取或复述历史各集完整剧本。连续性摘要必须继续保持压缩，确保集数增加时请求上下文不会按历史剧本线性增长。",
    };
}

async function requestGenerationCall(input: GenerationInput, onRefund: (pointsBalance?: number) => void) {
    const baseIdempotencyKey = generationIdempotencyKey(input);
    const headers = { "Content-Type": "application/json", cookie: input.cookie, ...systemAiBillingHeaders(input.model, baseIdempotencyKey, input.candidate.upstreamModel) };
    const fallbackHeaders = { "Content-Type": "application/json", cookie: input.cookie, ...systemAiBillingHeaders(input.model, `${baseIdempotencyKey}:fallback`, input.candidate.upstreamModel) };
    const call = await requestStructuredText({
        origin: resolveInternalOrigin(input.origin),
        cookie: input.cookie,
        candidate: input.candidate,
        messages: [
            {
                role: "system",
                content: `你是专业的漫剧剧本编剧。严格执行以下创作规则：单集总时长约 60 秒，开篇前 3 秒设置强看点；剧本严格按【镜号】+【画面描述】+【台词/旁白】+【音效/背景音乐】+【单镜时长】输出；画面描述具体具象，适合 AI 生成漫剧画面，明确人物表情、动作和场景环境；台词口语化且每句都有信息点；结尾设置悬念。另输出一份包含对白的完整故事文字。必须保持项目故事简介中的人物和大纲一致，后续章节要从上一集结尾自然承接。不要输出解释、Markdown 围栏或额外内容。${JSON.stringify(SCRIPT_TOOL.parameters)}`,
            },
            { role: "user", content: JSON.stringify(input.context) },
        ],
        tool: SCRIPT_TOOL,
        headers,
        fallbackHeaders,
        preferNativeTools: false,
        allowRepair: true,
        stream: true,
        streamFallback: true,
        signal: input.signal,
        validateArguments: (argumentsText) => isGeneratedScriptShape(argumentsText),
        onInvalidResponse: async (responseHeaders) => {
            const refund = await refundCall(input, responseHeaders);
            onRefund(refund?.pointsBalance);
        },
    });
    if (!isGeneratedScriptShape(call.arguments)) {
        const refund = await refundCall(input, call);
        onRefund(refund?.pointsBalance);
        throw new DramaScriptGenerationError("模型没有返回完整的剧本结构");
    }
    return call;
}

function parseGeneratedScript(value: string): GeneratedDramaScript {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const result = {
            script: text(parsed.script),
            storyText: text(parsed.storyText),
            outline: text(parsed.outline),
            hook: text(parsed.hook),
            nextPreview: text(parsed.nextPreview),
            continuitySummary: text(parsed.continuitySummary),
        };
        if (!isCompleteGeneratedScript(result)) throw new Error("incomplete");
        return result;
    } catch {
        throw new DramaScriptGenerationError("模型返回的剧本内容不完整");
    }
}

function replaceEpisode(project: DramaProject, episodeId: string, generated: GeneratedDramaScript): DramaProject {
    return {
        ...project,
        episodes: project.episodes.map((episode) =>
            episode.id === episodeId
                ? {
                      ...episode,
                      ...generated,
                      scriptRichContent: undefined,
                      reviewStatus: "draft" as const,
                      shots: [],
                      renderTask: undefined,
                      visualReview: undefined,
                  }
                : episode,
        ),
    };
}

function isGeneratedScriptShape(value: string | GeneratedDramaScript) {
    try {
        const parsed: Record<string, unknown> = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : (value as unknown as Record<string, unknown>);
        const script = text(parsed.script);
        return Boolean(
            script && ["storyText", "outline", "hook", "nextPreview", "continuitySummary"].every((key) => text(parsed[key])) && ["【镜号】", "【画面描述】", "【台词/旁白】", "【音效/背景音乐】", "【单镜时长】"].every((label) => script.includes(label)),
        );
    } catch {
        return false;
    }
}

function isCompleteGeneratedScript(value: GeneratedDramaScript): value is GeneratedDramaScript {
    return isGeneratedScriptShape(value);
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function generationIdempotencyKey(input: GenerationInput) {
    return systemAiIdempotencyKey("drama-script", input.userId, input.projectId, input.episodeId, input.requestId, input.candidate.channel.id, input.candidate.upstreamModel);
}

async function refundCall(input: GenerationInput, source: Headers | TextPlanningCall) {
    const billing = source instanceof Headers ? readSystemAiBilling(source) : readSystemAiBilling(source.headers);
    return hasSystemAiCharge(billing) ? refundUserPoints(input.userId, input.model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId) : null;
}

function readPointsRemaining(headers: Headers) {
    const value = Number(headers.get("x-vozeb-pro-points-remaining"));
    return Number.isFinite(value) ? value : undefined;
}

function shouldTryAnotherCandidate(error: unknown) {
    if (isStructuredTextFailure(error)) return false;
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    return status >= 500 || status === 408 || status === 429;
}
