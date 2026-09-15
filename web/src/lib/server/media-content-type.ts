import { fileTypeFromBuffer } from "file-type";

export async function resolveMediaMimeType(bytes: Buffer, type: "image" | "video" | "audio", declaredMime?: string | null) {
    const detectedMime = (await fileTypeFromBuffer(bytes))?.mime?.toLowerCase() || "";
    if (detectedMime.startsWith(`${type}/`)) return detectedMime;

    const normalizedDeclaredMime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (!normalizedDeclaredMime) {
        if (type === "video") return "video/mp4";
        if (type === "audio") return "audio/mpeg";
        return "image/png";
    }
    return normalizedDeclaredMime.startsWith(`${type}/`) ? normalizedDeclaredMime : "";
}
