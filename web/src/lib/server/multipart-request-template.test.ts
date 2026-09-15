import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchInternal: vi.fn(), fetchExternal: vi.fn() }));

vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternal }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchExternal }));

import { buildMultipartFormData } from "./multipart-request-template";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=", "base64");

describe("multipart request templates", () => {
    it("loads absolute signed site references through the internal API", async () => {
        mocks.fetchInternal.mockResolvedValue(new Response(PNG_BYTES, { headers: { "content-type": "image/png", "content-length": String(PNG_BYTES.length) } }));

        const form = await buildMultipartFormData({
            template: { prompt: "{{prompt}}", images: "{{images}}" },
            values: { prompt: "animate the reference" },
            references: [{ type: "image", url: "https://site.example/api/reference-assets/temporary/reference.png?purpose=provider-read&signature=test" }],
            origin: "http://internal",
            publicOrigin: "https://site.example",
            cookie: "session=test",
        });

        expect(form.get("prompt")).toBe("animate the reference");
        expect(form.get("images")).toBeInstanceOf(File);
        expect(mocks.fetchInternal).toHaveBeenCalledWith("http://internal/api/reference-assets/temporary/reference.png?purpose=provider-read&signature=test", expect.objectContaining({ headers: { cookie: "session=test" } }));
        expect(mocks.fetchExternal).not.toHaveBeenCalled();
    });
});
