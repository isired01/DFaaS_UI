# ============================================
# Stage 1: Build Frontend (Vite + React)
# ============================================
FROM node:20-alpine AS frontend
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ .
RUN npm run build

# ============================================
# Stage 2: Build Backend (Go + Gin) — multi-arch
# ============================================
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS backend
ARG TARGETOS
ARG TARGETARCH
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags="-s -w" -o /server ./cmd/server

# ============================================
# Stage 3: Runtime (immagine finale minimale)
# ============================================
FROM alpine:3.21

# Certificati SSL per le chiamate HTTPS al cluster K8s
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Binario Go
COPY --from=backend /server .

# Frontend compilato
COPY --from=frontend /app/ui/dist ./ui/dist

EXPOSE 8082

ENTRYPOINT ["./server"]
