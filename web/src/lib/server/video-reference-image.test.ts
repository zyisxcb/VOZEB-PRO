import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetchInternal: vi.fn(),
    fetchExternal: vi.fn(),
    writeReference: vi.fn(),
    sign: vi.fn(),
}));

vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternal }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchExternal }));
vi.mock("@/lib/server/reference-asset-store", () => ({ writeReferenceMediaDataUrl: mocks.writeReference }));
vi.mock("@/lib/server/reference-asset-access", () => ({ createSignedReferenceAssetUrl: mocks.sign }));

import { normalizeVideoProviderImageReferences } from "./video-reference-image";

describe("video provider image references", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.writeReference.mockResolvedValue({ token: "temporary/2026/08/20/images/reference.png" });
        mocks.sign.mockReturnValue("https://site.example/api/reference-assets/temporary/reference.png?purpose=provider-read&expires=9999999999&signature=normalized");
    });

    it("keeps PNG and JPEG references on the zero-copy path", async () => {
        const references = [image("https://cdn.example.com/reference.png"), image("https://cdn.example.com/reference.jpg")];

        await expect(normalize(references)).resolves.toEqual(references);
        expect(mocks.fetchInternal).not.toHaveBeenCalled();
        expect(mocks.fetchExternal).not.toHaveBeenCalled();
        expect(mocks.writeReference).not.toHaveBeenCalled();
    });

    it("converts an internal WebP original to a lossless PNG reference without resizing", async () => {
        const webp = await sharp({ create: { width: 37, height: 23, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } })
            .webp()
            .toBuffer();
        mocks.fetchInternal.mockResolvedValue(new Response(webp, { headers: { "content-type": "image/webp", "content-length": String(webp.length) } }));

        const [result] = await normalize([image("https://site.example/api/reference-assets/temporary/source.webp?purpose=provider-read&signature=test")]);

        expect(result?.url).toContain("signature=normalized");
        expect(mocks.fetchInternal).toHaveBeenCalledWith("http://internal/api/reference-assets/temporary/source.webp?purpose=provider-read&signature=test", { cache: "no-store" });
        const dataUrl = mocks.writeReference.mock.calls[0]?.[0] as string;
        const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        await expect(sharp(bytes).metadata()).resolves.toMatchObject({ format: "png", width: 37, height: 23 });
        expect(mocks.writeReference).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), "image", expect.objectContaining({ ownerUserId: "user-one", source: "video-reference-normalization", maxBytes: 20 * 1024 * 1024 }));
    });

    it("removes local WebP preview parameters and submits the original PNG source", async () => {
        const [result] = await normalize([image("https://site.example/api/reference-assets/permanent/source.png?purpose=provider-read&expires=9999999999&signature=source&format=webp&width=320")]);

        expect(result?.url).toBe("https://site.example/api/reference-assets/permanent/source.png?expires=9999999999&purpose=provider-read&signature=source");
        expect(mocks.fetchInternal).not.toHaveBeenCalled();
        expect(mocks.fetchExternal).not.toHaveBeenCalled();
        expect(mocks.writeReference).not.toHaveBeenCalled();
    });

    it("normalizes public WebP references through the guarded outbound fetcher", async () => {
        const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
            .webp()
            .toBuffer();
        mocks.fetchExternal.mockResolvedValue(new Response(webp));

        await normalize([image("https://cdn.example.com/reference.webp")]);

        expect(mocks.fetchExternal).toHaveBeenCalledWith("https://cdn.example.com/reference.webp", { cache: "no-store" }, { tlsVerify: undefined });
        expect(mocks.writeReference).toHaveBeenCalledOnce();
    });

    it("passes the channel TLS setting to public reference downloads", async () => {
        const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
            .webp()
            .toBuffer();
        mocks.fetchExternal.mockResolvedValue(new Response(webp));

        await normalizeVideoProviderImageReferences({
            references: [image("https://frp-bar.com:63960/api/jobs/reference/files/0")],
            userId: "user-one",
            internalOrigin: "http://internal",
            publicOrigin: "https://site.example",
            tlsVerify: false,
        });

        expect(mocks.fetchExternal).toHaveBeenCalledWith("https://frp-bar.com:63960/api/jobs/reference/files/0", { cache: "no-store" }, { tlsVerify: false });
    });

    it("uses matching provider credentials and stores the downloaded image locally", async () => {
        const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
            .png()
            .toBuffer();
        mocks.fetchExternal.mockResolvedValue(new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } }));

        const [result] = await normalizeVideoProviderImageReferences({
            references: [image("https://frp-bar.com:63960/api/jobs/reference/files/0")],
            userId: "user-one",
            internalOrigin: "http://internal",
            publicOrigin: "https://site.example",
            providerAuth: [{ baseUrl: "https://frp-bar.com:63960", headers: { authorization: "Bearer provider-key" }, tlsVerify: false }],
        });

        expect(result?.url).toContain("/api/reference-assets/");
        expect(result?.url).not.toContain("/api/jobs/reference/files/0");
        expect(mocks.fetchExternal).toHaveBeenCalledWith("https://frp-bar.com:63960/api/jobs/reference/files/0", { headers: { authorization: "Bearer provider-key" }, cache: "no-store" }, { tlsVerify: false });
        expect(mocks.writeReference).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), "image", expect.any(Object));
    });
});

function normalize(references: Array<{ type: "image"; role: "reference"; url: string }>) {
    return normalizeVideoProviderImageReferences({ references, userId: "user-one", internalOrigin: "http://internal", publicOrigin: "https://site.example" });
}

function image(url: string) {
    return { type: "image" as const, role: "reference" as const, url };
}
