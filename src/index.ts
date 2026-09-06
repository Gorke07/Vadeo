import { api, readState } from "./backend/routes";
import { notify } from "./notify";
import { buildFrontend } from "./build";

// İmaj kurulurken derlendiyse tekrar derleme: /app yazılabilir olmak zorunda kalmasın.
if (!process.env.VADEO_PREBUILT) await buildFrontend();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 2340),

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) return api(req, url);

    // Statik: "/" -> HTML kabuğu, gerisi Bun.build çıktısı (public/).
    if (url.pathname.includes("..") || url.pathname.includes("%2e")) {
      return new Response("Not found", { status: 404 });
    }
    // Uzantısız her yol bir uygulama rotası: kabuğu dön, gerisini istemci çözer.
    if (!url.pathname.includes(".")) return new Response(Bun.file("src/frontend/index.html"));

    // Uzantılı yollar: önce derleme çıktısı, sonra elle konmuş varlıklar (ikon, manifest, sw).
    for (const dir of ["public", "src/frontend/assets"]) {
      const file = Bun.file(`${dir}${url.pathname}`);
      if (await file.exists()) {
        const headers: Record<string, string> = {};
        // Bun .webmanifest'i tanımıyor; tarayıcının kabul edeceği türü elle ver.
        if (url.pathname.endsWith(".webmanifest")) headers["Content-Type"] = "application/manifest+json";
        // Service worker her açılışta tazelensin, yoksa eski sürüm yapışır.
        if (url.pathname === "/sw.js") headers["Cache-Control"] = "no-cache";
        return new Response(file, { headers });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Vadeo -> http://localhost:${server.port}`);

// Bildirim: sunucu zaten ayakta, saatte bir bakar. Sistemde cron/servis kurulmaz.
// Yapılandırma Ayarlar sayfasından değişebildiği için koşulsuz çalışır; notify()
// token yoksa hiçbir şey yapmadan döner.
const tick = () =>
  notify(readState()).then((r) => r.sent > 0 && console.log(`[vadeo] bildirim: ${r.sent} olay — ${r.reason}`));
setInterval(tick, 60 * 60 * 1000).unref();
tick();
