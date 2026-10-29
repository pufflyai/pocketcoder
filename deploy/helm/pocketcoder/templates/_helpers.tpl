{{- define "pocketcoder.labels" -}}
app.kubernetes.io/name: pocketcoder-server
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "pocketcoder.selector" -}}
app.kubernetes.io/name: pocketcoder-server
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pocketcoder.workspaceNamespace" -}}
{{- default .Release.Namespace .Values.workspace.namespace -}}
{{- end }}

{{- define "pocketcoder.dataClaim" -}}
{{- default (printf "%s-data" .Release.Name) .Values.data.existingClaim -}}
{{- end }}

{{- define "pocketcoder.journalClaim" -}}
{{- default (printf "%s-journal" .Release.Name) .Values.journal.existingClaim -}}
{{- end }}

{{- define "pocketcoder.templatesConfigMap" -}}
{{- default (printf "%s-templates" .Release.Name) .Values.templates.configMap -}}
{{- end }}

{{/* Database settings shared by the migration step and the controller. */}}
{{- define "pocketcoder.databaseEnv" -}}
{{- if eq .Values.store.kind "postgres" }}
- name: POCKETCODER_STORE
  value: postgres
- name: POCKETCODER_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.store.database.urlSecret.name }}
      key: {{ .Values.store.database.urlSecret.key }}
- name: POCKETCODER_DATABASE_SCHEMA
  value: {{ .Values.store.database.schema | quote }}
{{- if .Values.store.database.caConfigMap.name }}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/pocketcoder/database-ca/{{ .Values.store.database.caConfigMap.key }}
{{- end }}
{{- else }}
- name: POCKETCODER_STORE
  value: pglite
{{- end }}
{{- end }}

{{- define "pocketcoder.databaseMounts" -}}
{{- if and (eq .Values.store.kind "postgres") .Values.store.database.caConfigMap.name }}
- name: database-ca
  mountPath: /etc/pocketcoder/database-ca
  readOnly: true
{{- end }}
{{- end }}
