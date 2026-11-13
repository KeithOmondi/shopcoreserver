{{- define "shopcore.name" -}}shopcore{{- end -}}

{{- define "shopcore.labels" -}}
app.kubernetes.io/name: {{ include "shopcore.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "shopcore.selector" -}}
app.kubernetes.io/name: {{ include "shopcore.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "shopcore.image" -}}
{{- if not .Values.image.tag -}}{{- fail "image.tag must be set to an immutable tag (git SHA)" -}}{{- end -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{/* Shared container env: non-secret config, endpoints, and secrets from the synced Secret. */}}
{{- define "shopcore.env" -}}
envFrom:
  - configMapRef:
      name: {{ .Release.Name }}-config
  - secretRef:
      name: {{ .Release.Name }}-secrets
env:
  - name: SERVICE_NAME
    value: {{ .Release.Name }}
  - name: POD_NAME
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: "k8s.pod.name=$(POD_NAME),service.version={{ .Values.image.tag }}"
{{- end -}}

{{- define "shopcore.securityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
{{- end -}}
