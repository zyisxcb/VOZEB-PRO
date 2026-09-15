import { mediaReferenceToFile } from "@/app/api/image-tasks/image-task-support";

import { renderTemplateValue } from "@/lib/server/provider-task-config";

export type MultipartTemplateReference = {
    url?: string;
    dataUrl?: string;
    name?: string;
    type?: string;
    role?: string;
};

const MULTIPART_TEMPLATE_PREFIX = "multipart/form-data";
const FILE_PLACEHOLDER_KEYS = new Set(["image", "images", "video", "videos", "audio", "audios", "references"]);
const MEDIA_KIND_BY_KEY: Record<string, "image" | "video" | "audio"> = {
    image: "image",
    images: "image",
    video: "video",
    videos: "video",
    audio: "audio",
    audios: "audio",
    references: "image",
};

export function isMultipartRequestTemplate(template: string | undefined) {
    return Boolean(template?.trim().toLowerCase().startsWith(MULTIPART_TEMPLATE_PREFIX));
}

export function parseMultipartRequestTemplate(template: string | undefined): Record<string, unknown> | null {
    const value = (template || "").trim();
    if (!value.toLowerCase().startsWith(MULTIPART_TEMPLATE_PREFIX)) return null;
    const json = value.slice(MULTIPART_TEMPLATE_PREFIX.length).trim().replace(/^:/, "").trim();
    if (!json.startsWith("{")) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("multipart 请求模板必须跟随有效 JSON 字段映射");
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

export async function buildMultipartFormData(options: {
    template: Record<string, unknown>;
    values: Record<string, unknown>;
    references: ReadonlyArray<MultipartTemplateReference>;
    origin: string;
    cookie: string;
    tlsVerify?: boolean;
    publicOrigin?: string;
}) {
    const formData = new FormData();
    for (const [field, rawValue] of Object.entries(options.template)) {
        const placeholder = typeof rawValue === "string" ? rawValue.match(/^\{\{\s*([\w.]+)\s*\}\}$/)?.[1]?.toLowerCase() || "" : "";
        if (placeholder && FILE_PLACEHOLDER_KEYS.has(placeholder)) {
            await appendTemplateReferenceFiles(formData, field, placeholder, options);
            continue;
        }
        const rendered = renderTemplateValue(rawValue, options.values);
        if (rendered === undefined || rendered === null) continue;
        const text = typeof rendered === "string" ? rendered : String(rendered);
        if (!text.trim() || text.includes("{{")) continue;
        formData.set(field, text);
    }
    return formData;
}

async function appendTemplateReferenceFiles(formData: FormData, field: string, placeholder: string, options: { template: Record<string, unknown>; references: ReadonlyArray<MultipartTemplateReference>; origin: string; cookie: string; tlsVerify?: boolean; publicOrigin?: string }) {
    const mediaKind = MEDIA_KIND_BY_KEY[placeholder] || "image";
    const selected = selectTemplateReferences(placeholder, mediaKind, options.references);
    for (const reference of selected) {
        const name = reference.name || `${placeholder}-${selected.indexOf(reference) + 1}.${mediaKind === "image" ? "png" : mediaKind === "video" ? "mp4" : "bin"}`;
        const file = await mediaReferenceToFile(reference, name, options.origin, options.cookie, referenceMediaKind(reference, mediaKind), options.tlsVerify !== false, options.publicOrigin);
        formData.append(field, file, name);
    }
}

function selectTemplateReferences(placeholder: string, mediaKind: "image" | "video" | "audio", references: ReadonlyArray<MultipartTemplateReference>) {
    const all = Array.from(references);
    if (placeholder === "references") return all;
    const typed = all.filter((reference) => referenceMediaKind(reference, mediaKind) === mediaKind);
    return placeholder.endsWith("s") ? typed : typed.slice(0, 1);
}

function referenceMediaKind(reference: MultipartTemplateReference, fallback: "image" | "video" | "audio"): "image" | "video" | "audio" {
    const type = (reference.type || "").toLowerCase();
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("image/")) return "image";
    if (type === "video" || type === "audio" || type === "image") return type;
    return fallback;
}
