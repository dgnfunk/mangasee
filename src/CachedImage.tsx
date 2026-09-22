import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { CONTENT_CACHE } from "./offline";
// Read explicit downloads directly as blobs too: offline book rendering must not
// depend on the browser dispatching a network-shaped request to a service worker.
export default function CachedImage({
  src,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolved, setResolved] = useState<string>();
  useEffect(() => {
    let active = true;
    let blobUrl: string | undefined;
    setResolved(undefined);
    if ("caches" in window)
      void caches
        .open(CONTENT_CACHE)
        .then((c) => c.match(src))
        .then(async (response) => {
          if (!response) {
            if (active) setResolved(src);
            return;
          }
          const blob = await response.blob();
          if (!active) return;
          blobUrl = URL.createObjectURL(blob);
          setResolved(blobUrl);
        })
        .catch(() => {
          if (active) setResolved(src);
        });
    else setResolved(src);
    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);
  return <img {...props} src={resolved} />;
}
