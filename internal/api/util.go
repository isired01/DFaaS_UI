package api

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func parseStatusTime(obj map[string]interface{}, field string) (time.Time, bool) {
	raw := getNestedString(obj, "status", field)
	if raw == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

var dns1123Sub = regexp.MustCompile(`[^a-z0-9-]+`)

func sanitizeDNS1123(s string) string {
	s = strings.ToLower(s)
	s = dns1123Sub.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 253 {
		s = s[:253]
	}
	return s
}

func getNestedString(obj map[string]interface{}, fields ...string) string {
	val, _, _ := unstructured.NestedString(obj, fields...)
	return val
}

func getStringFromMap(m map[string]interface{}, key string) string {
	val, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := val.(string)
	if !ok {
		return fmt.Sprintf("%v", val)
	}
	return s
}

func getIntFromMap(m map[string]interface{}, key string) int {
	val, ok := m[key]
	if !ok {
		return 0
	}
	switch v := val.(type) {
	case int64:
		return int(v)
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}
