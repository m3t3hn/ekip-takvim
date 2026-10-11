/** The project on GitHub, where the docs live. */
export const REPO_URL = "https://github.com/m3t3hn/ekip-takvim";

/** A page in the docs folder, or the docs index. */
export function docsUrl(page?: string): string {
  return page ? `${REPO_URL}/blob/main/docs/${page}` : `${REPO_URL}/tree/main/docs#readme`;
}
