import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthSettings: vi.fn(),
    resolveLogicalModelCandidates: vi.fn(),
    requestStructuredText: vi.fn(),
    getDramaProjectForUser: vi.fn(),
    createDramaProjectVersionForUser: vi.fn(),
    updateDramaProjectForUser: vi.fn(),
    refundUserPoints: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings, refundUserPoints: mocks.refundUserPoints }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.resolveLogicalModelCandidates }));
vi.mock("@/lib/server/text-planning-runtime", () => ({
    isStructuredTextFailure: vi.fn(() => false),
    rankTextPlanningCandidates: vi.fn((items: unknown[]) => items),
    requestStructuredText: mocks.requestStructuredText,
}));
vi.mock("@/lib/server/drama-project-service", () => ({
    createDramaProjectVersionForUser: mocks.createDramaProjectVersionForUser,
    getDramaProjectForUser: mocks.getDramaProjectForUser,
    updateDramaProjectForUser: mocks.updateDramaProjectForUser,
}));

import { generateDramaEpisodeScriptForUser } from "./drama-script-generation";

describe("drama script generation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getAuthSettings.mockResolvedValue({ defaultModels: { textModel: "writer" } });
        mocks.resolveLogicalModelCandidates.mockReturnValue([
            {
                channelId: "channel-one",
                upstreamModel: "writer-v1",
                channel: { id: "channel-one", advancedConfig: { contextWindowTokens: 8_000 } },
            },
        ]);
        mocks.requestStructuredText.mockResolvedValue({
            arguments: JSON.stringify({
                script: "【镜号】1\n【画面描述】雨夜，主角抬头。\n【台词/旁白】快走！\n【音效/背景音乐】雷声\n【单镜时长】6秒",
                storyText: "雨夜里，主角抬头说：“快走！”",
                outline: "主角在雨夜发现线索",
                hook: "雷光中出现陌生身影",
                nextPreview: "陌生身影说出了主角的名字。",
                continuitySummary: "已发生：主角在雨夜发现线索。人物状态：主角警觉。未解决线索：陌生身影的身份。结尾：主角准备追问。承接：下一集从陌生身影叫出主角名字开始。",
            }),
            headers: new Headers({ "x-vozeb-pro-points-remaining": "88" }),
            protocol: "chat",
            elapsedMs: 10,
        });
        mocks.updateDramaProjectForUser.mockImplementation(async (_userId: string, _projectId: string, project: unknown) => project);
    });

    it("passes only the previous continuity ledger and persists all generated fields", async () => {
        const project = {
            id: "drama-one",
            title: "测试短剧",
            summary: "主角必须查明身世，故事发生在一座被封锁的城中。",
            style: "电影感国漫",
            ratio: "9:16",
            status: "active" as const,
            activeEpisodeId: "episode-three",
            characters: [],
            scenes: [],
            props: [],
            clues: [],
            defaultVideoMode: "storyboard" as const,
            episodes: [
                { id: "episode-one", episodeNumber: 1, title: "第 1 集", script: "历史完整剧本，不应进入本次请求", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft" as const, shots: [] },
                {
                    id: "episode-two",
                    episodeNumber: 2,
                    title: "第 2 集",
                    script: "上一集完整剧本，不应进入本次请求",
                    outline: "",
                    hook: "",
                    nextPreview: "从城门线索继续",
                    continuitySummary: "上一集账本：主角拿到城门钥匙；反派已经发现线索；钥匙的来源仍未揭开。",
                    reviewStatus: "draft" as const,
                    shots: [],
                },
                { id: "episode-three", episodeNumber: 3, title: "第 3 集", script: "", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft" as const, shots: [] },
            ],
            createdAt: "2026-09-15T00:00:00.000Z",
            updatedAt: "2026-09-15T00:00:00.000Z",
        };
        mocks.getDramaProjectForUser.mockResolvedValue(project);

        const result = await generateDramaEpisodeScriptForUser({ userId: "user-one", projectId: project.id, episodeId: "episode-three", requestId: "request-one", origin: "http://localhost:3000", cookie: "session=test" });
        const messages = mocks.requestStructuredText.mock.calls[0]?.[0].messages as Array<{ role: string; content: string }>;
        const context = messages.at(-1)?.content || "";

        expect(context).toContain(project.summary);
        expect(context).toContain("上一集账本：主角拿到城门钥匙");
        expect(context).not.toContain("历史完整剧本");
        expect(context).not.toContain("上一集完整剧本");
        expect(mocks.createDramaProjectVersionForUser).toHaveBeenCalledWith("user-one", project.id, expect.objectContaining({ reason: "AI 剧本生成前", snapshot: project }));
        expect(result.project.episodes[2]).toMatchObject({
            script: expect.stringContaining("【镜号】1"),
            storyText: expect.stringContaining("快走"),
            continuitySummary: expect.stringContaining("陌生身影"),
            shots: [],
            reviewStatus: "draft",
        });
        expect(result.pointsRemaining).toBe(88);
    });
});
