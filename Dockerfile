# discovery-vessel Dockerfile
# Build lightweight discovery vessel for impulse resolution
#
# Build context: Parent directory (for potential future dependencies)
# Build: docker build -f Dockerfile -t discovery-vessel:latest .

# Build arguments for version embedding
ARG BUILD_SHA
ARG BUILD_VERSION

FROM oven/bun:1.2 AS build
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY index.ts ./
COPY tsconfig.json ./

# Verify TypeScript compilation
RUN bun build src/index.ts --target bun --outdir dist

FROM oven/bun:1.2-slim
WORKDIR /app

# Re-declare build args for this stage
ARG BUILD_SHA
ARG BUILD_VERSION

# Copy dependencies and source from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/index.ts ./
COPY --from=build /app/package.json ./

# Environment configuration
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
# Version information for tracing
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_VERSION=${BUILD_VERSION}

# Expose HTTP port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1))"

# Run as non-root user for security
USER bun

# Run the server
CMD ["bun", "run", "index.ts"]
