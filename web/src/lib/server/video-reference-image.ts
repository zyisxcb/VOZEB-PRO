import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { originalImageSourceUrl } from "@/lib/media-image-url";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { createSignedReferenceAssetUrl } from "@/lib/server/reference-asset-access";
import { writeReferenceMediaDataUrl } from "@/lib/server/reference-asset-store";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import type { VideoGenerationReference } from "@/lib/video-reference-contract";

const UPSTREAM_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

export type VideoProviderReferenceAuth = {
    baseUrl: string;
    headers: Record<string, string>;
    tlsVerify?: boolean;
};

export async function normalizeVideoProviderImageReferences(input: { references: VideoGenerationReference[]; userId: string; internalOrigin: string; publicOrigin: string; tlsVerify?: boolean; providerAuth?: VideoProviderReferenceAuth[] }) {
    return Promise.all(input.references.map((reference) => normalizeReference(reference, input)));
}

async function normalizeReference(reference: VideoGenerationReference, context: { userId: string; internalOrigin: string; publicOrigin: string; tlsVerify?: boolean; providerAuth?: VideoProviderReferenceAuth[] }) {
    if (reference.type !== "image") return reference;
    const sourceReference = { ...reference, url: originalImageSourceUrl(reference.url) };
    const providerAuth = matchingProviderReferenceAuth(sourceReference.url, context.providerAuth);
    if (!providerAuth && hasUpstreamImageExtension(sourceReference.url)) return sourceReference;
    const source = await readReferenceImage(sourceReference.url, context, providerAuth);
    if (UPSTREAM_IMAGE_MIME_TYPES.has(source.mimeType) && !providerAuth) return sourceReference;
    if (!source.mimeType.startsWith("image/")) throw new Error("视频参考素材不是有效图片");

    const png = await sharp(source.bytes, { failOn: "error" }).rotate().png().toBuffer();
    const asset = await writeReferenceMediaDataUrl(`data:image/png;base64,${png.toString("base64")}`, "image", {
        ownerUserId: context.userId,
        source: "video-reference-normalization",
        originalName: "video-reference.png",
        maxBytes: CREATIVE_UPLOAD_MAX_BYTES,
    });
    const url = createSignedReferenceAssetUrl(asset.token, context.publicOrigin, context.userId);
    if (!url) throw new Error("视频参考素材签名不可用，请检查站点地址和加密密钥");
    return { ...reference, url };
}

async function readReferenceImage(value: string, context: { internalOrigin: string; publicOrigin: string; tlsVerify?: boolean }, providerAuth?: VideoProviderReferenceAuth) {
    const url = new URL(value, context.publicOrigin);
    const publicOrigin = new URL(context.publicOrigin).origin;
    const internal = url.origin === publicOrigin && ["/api/reference-assets/", "/api/generation-log-assets/"].some((prefix) => url.pathname.startsWith(prefix));
    const target = internal ? `${context.internalOrigin.replace(/\/+$/, "")}${url.pathname}${url.search}` : url.toString();
    const response = await (internal
        ? fetchInternalApi(target, { cache: "no-store" })
        : fetchSafeOutbound(target, { ...(providerAuth?.headers && Object.keys(providerAuth.headers).length ? { headers: providerAuth.headers } : {}), cache: "no-store" }, { tlsVerify: providerAuth?.tlsVerify ?? context.tlsVerify }));
    if (!response.ok || !response.body) throw new Error(`视频参考素材读取失败（${response.status}）`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new Error("视频参考图片不能超过 20MB");
    const bytes = await readBoundedBytes(response.body);
    const mimeType = (await fileTypeFromBuffer(bytes))?.mime?.toLowerCase() || "";
    return { bytes, mimeType };
}

function matchingProviderReferenceAuth(value: string, candidates: VideoProviderReferenceAuth[] | undefined) {
    if (!candidates?.length) return undefined;
    let target: URL;
    try {
        target = new URL(value);
    } catch {
        return undefined;
    }
    return candidates.find((candidate) => {
        try {
            return target.origin === new URL(candidate.baseUrl).origin && Object.keys(candidate.headers).length > 0;
        } catch {
            return false;
        }
    });
}

async function readBoundedBytes(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > CREATIVE_UPLOAD_MAX_BYTES) {
                await reader.cancel("Video reference exceeds upload limit").catch(() => undefined);
                throw new Error("视频参考图片不能超过 20MB");
            }
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }
    if (!total) throw new Error("视频参考素材为空");
    return Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
    );
}

function hasUpstreamImageExtension(value: string) {
    try {
        const url = new URL(value);
        if (url.searchParams.get("format")?.toLowerCase() === "webp") return false;
        return /\.(?:png|jpe?g)$/i.test(url.pathname);
    } catch {
        return false;
    }
}
