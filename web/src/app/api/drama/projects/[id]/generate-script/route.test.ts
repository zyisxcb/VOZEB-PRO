import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    checkRateLimit: vi.fn(),
    generateDramaEpisodeScriptForUser: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/security", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server/drama-script-generation", () => ({
    DramaScriptGenerationError: class DramaScriptGenerationError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    generateDramaEpisodeScriptForUser: mocks.generateDramaEpisodeScriptForUser,
}));

import { POST } from "./route";

describe("POST /api/drama/projects/[id]/generate-script", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.checkRateLimit.mockResolvedValue({ allowed: true });
        mocks.generateDramaEpisodeScriptForUser.mockResolvedValue({ project: { id: "drama-one" }, result: { script: "剧本" }, pointsRemaining: 90 });
    });

    it("requires authentication before reading the generation request", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);

        const response = await POST(new Request("http://localhost/api/drama/projects/drama-one/generate-script", { method: "POST", body: JSON.stringify({ episodeId: "episode-one", requestId: "request-one" }) }), context("drama-one"));

        expect(response.status).toBe(401);
        expect(mocks.generateDramaEpisodeScriptForUser).not.toHaveBeenCalled();
    });

    it("passes the stable project and episode identity to the service", async () => {
        const response = await POST(
            new Request("http://localhost/api/drama/projects/drama-one/generate-script", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ episodeId: "episode-one", requestId: "request-one" }),
            }),
            context("drama-one"),
        );

        expect(response.status).toBe(200);
        expect(mocks.generateDramaEpisodeScriptForUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-one", projectId: "drama-one", episodeId: "episode-one", requestId: "request-one", cookie: "session=test" }));
        expect(response.headers.get("x-vozeb-pro-points-remaining")).toBe("90");
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { project: { id: "drama-one" } } });
    });
});

function context(id: string) {
    return { params: Promise.resolve({ id }) };
}
