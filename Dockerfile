FROM oven/bun:1

WORKDIR /app

# Bağımlılıklar önce: kaynak değişince bu katman yeniden kurulmasın.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

# Frontend imaj kurulurken bir kez derleniyor. Böylece çalışma anında /app'e
# yazılmıyor ve container herhangi bir uid ile koşabiliyor — Unraid'in
# nobody:users (99:100) kimliği dahil.
ENV NODE_ENV=production
RUN bun run build && chmod -R a+rX /app

ENV VADEO_PREBUILT=1
ENV VADEO_DB=/data/db.sqlite
ENV PORT=2340
EXPOSE 2340

# Kök olarak çalışmaya gerek yok. Unraid gibi başka bir uid dayatan ortamlarda
# --user ile geçersiz kılınabilir; yazılan tek yer /data.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:2340/api/auth"); process.exit(r.ok ? 0 : 1)'

CMD ["bun", "run", "src/index.ts"]
