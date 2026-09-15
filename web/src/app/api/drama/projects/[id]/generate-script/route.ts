import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { DramaScriptGenerationError, generateDramaEpisodeScriptForUser } from "@/lib/server/drama-script-generation";
import { DramaProjectServiceError } from "@/lib/server/drama-project-service";
import { checkRateLimit } from "@/lib/server/security";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!(await checkRateLimit(`drama-script-generation:${user.id}`, { maxRequests: 10, windowMs: 60_000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "AI 剧本生成过于频繁，请稍后重试" }, { status: 429 });
    const parsed = await readJsonBodyResult<unknown>(request, 64 * 1024);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const body = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>) : {};
    const episodeId = typeof body.episodeId === "string" ? body.episodeId.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!episodeId || !requestId || requestId.length > 200) return NextResponse.json({ code: 400, data: null, msg: "AI 剧本生成参数无效" }, { status: 400 });
    try {
        const result = await generateDramaEpisodeScriptForUser({ userId: user.id, projectId: (await context.params).id, episodeId, requestId, origin: new URL(request.url).origin, cookie: request.headers.get("cookie") || "", signal: request.signal });
        const response = NextResponse.json({ code: 0, data: result, msg: "AI 剧本已生成" });
        if (typeof result.pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(result.pointsRemaining));
        return response;
    } catch (error) {
        if (error instanceof DramaScriptGenerationError || error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        return NextResponse.json({ code: 502, data: null, msg: error instanceof Error ? error.message : "AI 剧本生成失败" }, { status: 502 });
    }
}
