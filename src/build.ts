/**
 * Frontend derlemesi. Ayrı dosya, çünkü iki yerden çağrılıyor:
 * geliştirmede sunucu açılışında, imaj kurulurken bir kez (RUN bun run src/build.ts).
 * İmajda önceden derlenince çalışma anında /app'e yazma ihtiyacı kalmıyor;
 * container herhangi bir uid ile koşabiliyor (Unraid nobody:users gibi).
 */
export async function buildFrontend() {
  const result = await Bun.build({
    entrypoints: ["./src/frontend/index.tsx"],
    outdir: "./public",
    target: "browser",
    sourcemap: "linked",
    minify: process.env.NODE_ENV === "production",
  });
  if (!result.success) {
    console.error(result.logs.join("\n"));
    process.exit(1);
  }
  return result;
}

if (import.meta.main) await buildFrontend();
