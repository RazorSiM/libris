import { shallowRef } from "vue";
import { useMutation, useQueryCache } from "@pinia/colada";
import { inboxKeys } from "./queries/inboxKeys";

interface UploadResult {
  uploaded: { filename: string; size: number }[];
  errors: { filename: string; error: string }[];
}

export function useUpload() {
  const activeXhr = shallowRef<XMLHttpRequest | null>(null);
  const queryCache = useQueryCache();

  const {
    mutateAsync: uploadAsync,
    isLoading,
    error,
  } = useMutation({
    mutation: (vars: { files: File[]; onProgress?: (pct: number) => void }) => {
      const formData = new FormData();
      for (const f of vars.files) {
        formData.append("file", f);
      }

      return new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhr.value = xhr;
        xhr.open("POST", "/api/inbox/upload");
        xhr.withCredentials = true;

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable && vars.onProgress) {
            vars.onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener("load", () => {
          activeXhr.value = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            try {
              const err = JSON.parse(xhr.responseText);
              reject(new Error(err.message || err.error || "Upload failed"));
            } catch {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          }
        });

        xhr.addEventListener("error", () => {
          activeXhr.value = null;
          reject(new Error("Network error during upload"));
        });
        xhr.addEventListener("abort", () => {
          activeXhr.value = null;
          reject(new Error("Upload cancelled"));
        });

        xhr.send(formData);
      });
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: inboxKeys.list() }),
        queryCache.invalidateQueries({ key: inboxKeys.count() }),
      ]),
  });

  function upload(files: File[], onProgress?: (pct: number) => void): Promise<UploadResult> {
    return uploadAsync({ files, onProgress });
  }

  function cancel() {
    activeXhr.value?.abort();
  }

  return { upload, cancel, isLoading, error };
}
