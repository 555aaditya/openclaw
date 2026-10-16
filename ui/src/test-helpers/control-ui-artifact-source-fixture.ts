export function createArtifactSourceFixture(sessionKey: string, now = Date.now()) {
  const artifactId = "artifact_transcript_image_shared";
  const path = "/api/artifacts/download/fixture/shared-image";
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
  const artifact = {
    id: artifactId,
    type: "image",
    title: "Shared artifact",
    mimeType: "image/png",
    download: { mode: "bytes" },
  };
  return {
    path,
    data,
    images: Array.from({ length: 6 }, (_, index) => ({
      type: "image",
      artifactId,
      // Retained transcripts can carry either omission metadata or a historical URL.
      ...(index % 2
        ? {
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/shared-image/full?mediaTicket=old-${index}`,
          }
        : {}),
      alt: `Shared artifact ${index + 1}`,
      mimeType: "image/png",
      width: 1,
      height: 1,
    })),
    methodResponses: {
      "artifacts.download": {
        cases: [
          {
            match: { transport: "http" },
            response: { artifact, url: path, expiresAt: new Date(now + 300_000).toISOString() },
          },
          { response: { artifact, encoding: "base64", data } },
        ],
      },
    },
  };
}
