# dFaaS Control Plane — UI & API Gateway

Questo progetto è l'interfaccia di controllo per il sistema **dFaaS** (distributed Function-as-a-Service). Permette di monitorare gli esperimenti, configurare i test di carico con k6 e visualizzare lo stato della federazione edge/cloud.

## 🚀 Architettura
Il sistema è composto da due parti principali:
1. **Frontend (React + Vite)**: Un'interfaccia moderna e reattiva costruita con Tailwind CSS.
2. **Backend (Go + Gin)**: Un'API Gateway stateless che comunica direttamente con il cluster Kubernetes tramite il `dynamic client`.

---

## 🛠️ Prerequisiti
Assicurati di avere installato:
*   **Go** (1.21 o superiore)
*   **Node.js** (v18 o superiore) e **npm**
*   **kubectl** configurato per l'accesso a un cluster Kubernetes

---

## 📦 Installazione e Avvio (Sviluppo)

Per lo sviluppo, è consigliato lanciare il frontend e il backend separatamente per sfruttare l'Hot Module Replacement (HMR).

### 1. Avvio del Frontend
```bash
cd ui
npm install
npm run dev
```
La UI sarà disponibile su `http://localhost:5173`.

### 2. Avvio del Backend
In un altro terminale, dalla root del progetto:
```bash
go run ./cmd/server/main.go
```
Il server partirà su `http://localhost:8082`.

---

## ☸️ Connessione al Cluster Kubernetes

Il backend deve potersi connettere al cluster per leggere gli `Esperimenti` e lanciare i `TestRun`.

### Modalità Locale (Sviluppo)
Se lanci il backend dal tuo PC, cercherà la configurazione di Kubernetes in quest'ordine:
1.  Variabile d'ambiente `KUBECONFIG` (punta al path del tuo file `.yaml` di config).
2.  Percorso di default `~/.kube/config`.

**Esempio se hai un file config specifico:**
```bash
export KUBECONFIG=/path/to/your/cluster-config.yaml
go run ./cmd/server/main.go
```

### Modalità In-Cluster (Produzione)
Se il backend gira come un Pod dentro Kubernetes, userà automaticamente il **ServiceAccount** associato al Pod per autenticarsi.

---

## 🏗️ Build per la Produzione
Per creare un unico pacchetto dove il server Go serve anche i file statici della UI:

1.  **Build del Frontend:**
    ```bash
    cd ui
    npm run build
    ```
    Questo creerà la cartella `ui/dist`.

2.  **Build del Backend:**
    ```bash
    go build -o server ./cmd/server/main.go
    ```

3.  **Esecuzione:**
    ```bash
    ./server
    ```
    Il server rileverà la cartella `ui/dist` e servirà la UI su `http://localhost:8082`.

---

## ⚙️ Configurazione (.env)
Puoi creare un file `.env` nella root per personalizzare il comportamento:
*   `PORT`: La porta su cui gira il server (default: 8082).
*   `GIN_MODE`: Imposta a `release` in produzione.

---

## 📝 Note Tecniche
*   **Persistenza Locale:** La configurazione dei test K6 nel form viene salvata nel `localStorage` del browser, divisa per ogni singolo esperimento.
*   **Cleanup:** Se cancelli un esperimento dalla UI, tutte le risorse k6 associate (TestRun, ConfigMap) verranno eliminate automaticamente grazie alle `OwnerReferences` impostate dal backend.
