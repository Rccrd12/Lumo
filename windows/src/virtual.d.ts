// Modules vite.config.ts makes up at build time.

/** The repository's CHANGELOG.md, as text. */
declare module "virtual:lumo-changelog" {
  const text: string;
  export default text;
}
