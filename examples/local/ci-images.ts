export type CiImage = { context: string; dockerfile: string; commit: string; tag: string; imageId: string };

export function selectCiImage(
  images: CiImage[],
  commit: string,
  context: string,
  dockerfile = `${context}/Dockerfile`,
) {
  const image = images.find((entry) => entry.context === context && entry.dockerfile === dockerfile);
  if (!image) throw new Error(`CI image artifact does not cover the build recipe: ${dockerfile}`);
  if (image.commit !== commit) throw new Error("CI image source revision differs from the checked-out merge result");
  return image;
}

export async function readCiImage(context: string, dockerfile?: string) {
  const path = process.env.POCKETCODER_CI_IMAGE_MANIFEST;
  if (!path) return null;
  const images: CiImage[] = await Bun.file(path).json();
  return selectCiImage(images, process.env.GITHUB_SHA ?? "", context, dockerfile);
}
