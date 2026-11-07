# PDF pour Desktroo — © 2026 Mdm-services.fr. Tous droits réservés.
# L'éditeur est la version web officielle de PdfCraft (MIT OR Apache-2.0), téléchargée telle quelle depuis sa
# publication GitHub, vérifiée par son empreinte SHA-256 et servie sans modification sous /engine/.
FROM alpine:3.22 AS engine
ARG PDFCRAFT_VERSION=0.19.0
ARG PDFCRAFT_SHA256=6cecea09db4d010f1ae18d4c3170db243c7adc653699ba2711f570d57fed6947
RUN apk add --no-cache curl unzip \
 && curl -fsSL -o /tmp/web.zip "https://github.com/storytold/pdfcraft/releases/download/v${PDFCRAFT_VERSION}/pdfcraft-web-${PDFCRAFT_VERSION}.zip" \
 && echo "${PDFCRAFT_SHA256}  /tmp/web.zip" | sha256sum -c - \
 && unzip -q /tmp/web.zip -d /tmp/x \
 && mv "/tmp/x/pdfcraft-web-${PDFCRAFT_VERSION}" /engine \
 && rm -f /engine/.htaccess /engine/_headers \
 && gzip -9 -k /engine/*.wasm /engine/*.js

FROM node:20-alpine
ARG PDFCRAFT_VERSION=0.19.0
LABEL org.opencontainers.image.title="PDF pour Desktroo" \
      org.opencontainers.image.vendor="Mdm-services.fr" \
      org.opencontainers.image.source="https://github.com/Nabief/desktroo-pdf" \
      org.opencontainers.image.licenses="LicenseRef-Desktroo AND (MIT OR Apache-2.0)" \
      fr.desktroo.pdfcraft="${PDFCRAFT_VERSION}"
WORKDIR /app
COPY --from=engine /engine ./engine
COPY server.js dav.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
# Desktroo Apps lance le conteneur sous le compte du NAS prêté à l'app, en lecture seule hors des dossiers confiés.
CMD ["node", "server.js"]
