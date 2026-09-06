FROM oven/bun:1

WORKDIR /app

# Bağımlılıklar önce: kaynak değişince bu katman yeniden kurulmasın.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun src ./src
COPY tsconfig.json ./

# Bun.build çıktısı buraya yazılır; kök olmayan kullanıcı yazabilmeli.
RUN mkdir -p public && chown -R bun:bun /app

# Kök olarak çalışmaya gerek yok. uid 1000, tipik masaüstü kullanıcısıyla aynı,
# bu yüzden bağlanan ./data dizininde izin sorunu çıkmaz.
USER bun

ENV NODE_ENV=production
ENV VADEO_DB=/data/db.sqlite
ENV PORT=2340
EXPOSE 2340

# Ayakta kalması isteniyor: takılırsa Docker yeniden başlatabilsin.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:2340/api/auth"); process.exit(r.ok ? 0 : 1)'

CMD ["bun", "run", "src/index.ts"]
