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
		log.Printf("⚠️  Impossibile connettersi al cluster Kubernetes: %v", err)
		log.Println("Il server partirà comunque, ma le API K8s non funzioneranno.")
		log.Println("Imposta KUBECONFIG per connetterti a un cluster.")
	}

	// 2. Setup Gin
	r := gin.Default()

	// Healthz endpoint — used by K8s liveness/readiness probes.
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// 3. CORS: configurabile via env CORS_ORIGINS (csv).
	// Empty = same-origin only (in-cluster Helm install).
	// Defaults to localhost dev origins when env is unset for local `go run`.
	corsOrigins := parseCORSOrigins()
	if len(corsOrigins) > 0 {
		r.Use(cors.New(cors.Config{
			AllowOrigins:     corsOrigins,
			AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
			AllowCredentials: true,
		}))
	}

	// 4. Registra le API routes
	if k8sClient != nil {
		handler := api.NewHandler(k8sClient)
		handler.RegisterRoutes(r)
	} else {
		// Se non c'è un client K8s, restituisci errore per le API
		apiGroup := r.Group("/api")
		apiGroup.Any("/*path", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "Cluster Kubernetes non disponibile. Verifica KUBECONFIG.",
			})
		})
	}

	// 5. Serve il frontend statico (build di produzione)
	uiDistPath := getUIDistPath()
	if _, err := os.Stat(uiDistPath); err == nil {
		r.Static("/assets", filepath.Join(uiDistPath, "assets"))
		r.StaticFile("/favicon.ico", filepath.Join(uiDistPath, "favicon.ico"))

		// Tutte le rotte non-API servono index.html (SPA routing).
		// Per /api/* sconosciuti restituiamo JSON 404 invece di SPA fallback,
		// così il client non scarica index.html scambiandolo per la risposta API.
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api/") {
				c.JSON(http.StatusNotFound, gin.H{"error": "route not found: " + c.Request.URL.Path})
				return
			}
			c.File(filepath.Join(uiDistPath, "index.html"))
		})
		log.Printf("📂 Frontend servito da: %s", uiDistPath)
	} else {
		log.Printf("⚠️  Frontend non trovato in %s. Usa 'npm run dev' nella cartella ui/ per lo sviluppo.", uiDistPath)
	}

	// 6. Avvia il server
	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	log.Printf("🚀 DFaaS Control Plane avviato su http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Errore avvio server: %v", err)
	}
}

// parseCORSOrigins reads the CORS_ORIGINS env (csv).
// Unset → dev defaults (Vite + CRA).
// Explicit empty (CORS_ORIGINS="") → no CORS middleware (same-origin only).
func parseCORSOrigins() []string {
	v, set := os.LookupEnv("CORS_ORIGINS")
	if !set {
		return []string{"http://localhost:5173", "http://localhost:3000"}
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

// getUIDistPath determina il path della build frontend.
// In produzione (Docker) è relativo al binario.
// In sviluppo è relativo alla root del progetto.
func getUIDistPath() string {
	// Prima prova il path relativo al binario (Docker)
	exe, err := os.Executable()
	if err == nil {
		dockerPath := filepath.Join(filepath.Dir(exe), "ui", "dist")
		if _, err := os.Stat(dockerPath); err == nil {
			return dockerPath
		}
	}

	// Fallback al path relativo alla working directory
	return filepath.Join("ui", "dist")
}
