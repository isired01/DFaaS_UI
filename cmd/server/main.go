package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"dfaas-control-plane/internal/api"
)

func main() {
	// 1. Setup Kubernetes client
	k8sClient, err := api.NewK8sClient()
	if err != nil {
		log.Printf("could not build the Kubernetes client (%v); starting anyway: every /api route answers 503 until the server restarts with a usable kubeconfig", err)
	}

	// 2. Setup Gin
	r := gin.Default()

	// Healthz endpoint — used by K8s liveness/readiness probes.
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 3. CORS: configurable via the CORS_ORIGINS env (csv).
	// Empty = no CORS middleware and no CORS headers (in-cluster Helm install).
	// That is not a same-origin check: simple cross-origin POSTs still reach the handlers.
	// Unset = the Vite dev origin, for `go run`.
	corsOrigins := parseCORSOrigins()
	if len(corsOrigins) > 0 {
		// A literal "*" makes the lib emit Access-Control-Allow-Origin: * —
		// which every browser rejects when paired with credentials, silently
		// breaking every credentialed cross-origin call. Drop the credentials
		// flag instead of shipping a config that cannot work, and say so.
		allowCredentials := true
		for _, o := range corsOrigins {
			if o == "*" {
				log.Println("CORS_ORIGINS contains '*': AllowCredentials disabled (browsers reject a wildcard origin together with credentials). List explicit origins to keep credentialed requests working.")
				allowCredentials = false
				break
			}
		}
		r.Use(cors.New(cors.Config{
			AllowOrigins: corsOrigins,
			// PATCH is required by UpdateEnvironment and AbortLoadTest.
			AllowMethods:     []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type"},
			AllowCredentials: allowCredentials,
		}))
	}

	// 4. Register the API routes
	if k8sClient != nil {
		handler := api.NewHandler(k8sClient)
		handler.RegisterRoutes(r)
	} else {
		// No Kubernetes client: every /api route answers 503.
		apiGroup := r.Group("/api")
		apiGroup.Any("/*path", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "Kubernetes cluster unavailable: check KUBECONFIG.",
			})
		})
	}

	// 5. Serve the static frontend (production build)
	uiDistPath := getUIDistPath()
	if _, err := os.Stat(uiDistPath); err == nil {
		r.Static("/assets", filepath.Join(uiDistPath, "assets"))
		r.StaticFile("/favicon.svg", filepath.Join(uiDistPath, "favicon.svg"))

		// Every non-API route serves index.html (SPA routing). An unknown /api/*
		// path gets a JSON 404 instead, so the client never takes index.html for an
		// API response.
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api/") {
				c.JSON(http.StatusNotFound, gin.H{"error": "route not found: " + c.Request.URL.Path})
				return
			}
			c.File(filepath.Join(uiDistPath, "index.html"))
		})
		log.Printf("serving the frontend from %s", uiDistPath)
	} else {
		log.Printf("frontend not found in %s; for development run 'npm run dev' in ui/", uiDistPath)
	}

	// 6. Start the server
	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	log.Printf("DFaaS Control Plane listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

// parseCORSOrigins reads the CORS_ORIGINS env (csv).
// Unset → the Vite dev origin.
// Explicit empty (CORS_ORIGINS="") → no CORS middleware (no Access-Control-* headers; not a same-origin check).
func parseCORSOrigins() []string {
	v, set := os.LookupEnv("CORS_ORIGINS")
	if !set {
		return []string{"http://localhost:5173"}
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// getUIDistPath returns the frontend build directory: ui/dist next to the
// binary (the container image), else ui/dist under the working directory
// (development).
func getUIDistPath() string {
	// First the path next to the binary (the container image).
	exe, err := os.Executable()
	if err == nil {
		dockerPath := filepath.Join(filepath.Dir(exe), "ui", "dist")
		if _, err := os.Stat(dockerPath); err == nil {
			return dockerPath
		}
	}

	// Fall back to the working directory.
	return filepath.Join("ui", "dist")
}
