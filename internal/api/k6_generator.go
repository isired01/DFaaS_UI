package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"text/template"
)

const k6AdvancedTemplate = `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
{{- range .Scenarios }}
    "{{ .Name }}": {
      executor: {{ if .Executor }}'{{ .Executor }}'{{ else }}'ramping-arrival-rate'{{ end }},
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: {{ .PreAllocatedVUs }},
      maxVUs: {{ .MaxVUs }},
      startTime: '{{ .StartTime }}',
      stages: [
        {{- range .Stages }}
        { duration: '{{ .Duration }}', target: {{ .Target }} },
        {{- end }}
      ],
      exec: 'runScenario',
      env: { SCENARIO_ID: '{{ .Name }}' },
    },
{{- end }}
  },
};

const scenarioConfig = {
{{- range .Scenarios }}
  "{{ .Name }}": {
    method: '{{ .Method }}',
    url: '{{ .TargetURL }}',
    body: {{ if .Body }}{{ .Body | js }}{{ else }}null{{ end }},
    headers: {{ if .Headers }}{{ .Headers }}{{ else }}{}{{ end }},
  },
{{- end }}
};

export function runScenario() {
  const conf = scenarioConfig[__ENV.SCENARIO_ID];
  const params = { headers: conf.headers };
  
  let res;
  switch (conf.method.toUpperCase()) {
    case 'GET':
      res = http.get(conf.url, params);
      break;
    case 'POST':
      res = http.post(conf.url, conf.body, params);
      break;
    case 'PUT':
      res = http.put(conf.url, conf.body, params);
      break;
    case 'DELETE':
      res = http.del(conf.url, conf.body, params);
      break;
    default:
      res = http.get(conf.url, params);
  }

  // Debug: se la richiesta fallisce, stampa il motivo nei log
  if (res.status < 200 || res.status >= 300) {
    console.log('❌ Request failed! URL: ' + conf.url + ' | Status: ' + res.status + ' | Body: ' + res.body);
  }

  check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
}
`

// GenerateK6ScriptAdvanced genera uno script k6 per scenari multipli.
func GenerateK6ScriptAdvanced(req K6GenerateRequest) (string, error) {
	tmpl, err := template.New("k6").Funcs(template.FuncMap{
		"js": func(s string) string {
			b, _ := json.Marshal(s)
			return string(b)
		},
	}).Parse(k6AdvancedTemplate)
	if err != nil {
		return "", err
	}

	var script bytes.Buffer
	if err := tmpl.Execute(&script, req); err != nil {
		return "", err
	}

	return script.String(), nil
}

// GenerateK6TestRunYAML genera il manifest YAML per la risorsa TestRun
// del k6-operator ufficiale (k6.io/v1alpha1).
func GenerateK6TestRunYAML(script string, name string, expName string, metricsQueries string) string {
	// Indenta lo script per il campo inline del ConfigMap
	indentedScript := indentString(script, "    ")

	var sb strings.Builder

	// 1. ConfigMap con lo script
	sb.WriteString(fmt.Sprintf(`apiVersion: v1
kind: ConfigMap
metadata:
  name: %s-script
data:
  test.js: |
%s
---
`, name, indentedScript))

	// 2. TestRun resource
	sb.WriteString(fmt.Sprintf(`apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: %s
`, name))

	hasAnnotations := false
	if metricsQueries != "" {
		if !hasAnnotations {
			sb.WriteString("  annotations:\n")
			hasAnnotations = true
		}
		sb.WriteString(fmt.Sprintf("    dfaas.io/metrics-queries: \"%s\"\n", metricsQueries))
	}

	if expName != "" {
		sb.WriteString("  labels:\n")
		sb.WriteString(fmt.Sprintf("    dfaas.io/experiment-name: %s\n", expName))
	}

	sb.WriteString(fmt.Sprintf(`spec:
  parallelism: 1
  script:
    configMap:
      name: %s-script
      file: test.js
  runner:
    image: ghcr.io/grafana/k6:latest
`, name))

	return sb.String()
}

// indentString aggiunge un prefisso di indentazione ad ogni riga.
func indentString(s string, indent string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if line != "" {
			lines[i] = indent + line
		}
	}
	return strings.Join(lines, "\n")
}
