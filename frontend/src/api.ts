import type {
  Annotation,
  AnnotationCreate,
  AnnotationUpdate,
  AttributeCreate,
  AttributeDefinition,
  AttributeUpdate,
  DetectStructureResponse,
  Document,
  Label,
  LabelCreate,
  LabelUpdate,
  OllamaStatus,
  Page,
  Project,
  SearchHit,
  SuggestAttributesIn,
  SuggestAttributesOut,
} from "./types";

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  getProject: (id: number) => jsonRequest<Project>(`/api/projects/${id}`),
  listLabels: (projectId: number) => jsonRequest<Label[]>(`/api/projects/${projectId}/labels`),
  createLabel: (projectId: number, payload: LabelCreate) =>
    jsonRequest<Label>(`/api/projects/${projectId}/labels`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateLabel: (projectId: number, labelId: number, payload: LabelUpdate) =>
    jsonRequest<Label>(`/api/projects/${projectId}/labels/${labelId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteLabel: (projectId: number, labelId: number) =>
    jsonRequest<void>(`/api/projects/${projectId}/labels/${labelId}`, {
      method: "DELETE",
    }),
  listDocuments: (projectId: number) =>
    jsonRequest<Document[]>(`/api/projects/${projectId}/documents`),
  getDocument: (id: number) => jsonRequest<Document>(`/api/documents/${id}`),
  pdfUrl: (id: number) => `/api/documents/${id}/pdf`,
  getPage: (documentId: number, pageNum: number) =>
    jsonRequest<Page>(`/api/documents/${documentId}/pages/${pageNum}`),
  getAllPages: (documentId: number) =>
    jsonRequest<Page[]>(`/api/documents/${documentId}/pages`),
  listAnnotations: (documentId: number) =>
    jsonRequest<Annotation[]>(`/api/documents/${documentId}/annotations`),
  createAnnotation: (payload: AnnotationCreate) =>
    jsonRequest<Annotation>("/api/annotations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAnnotation: (id: number, payload: AnnotationUpdate) =>
    jsonRequest<Annotation>(`/api/annotations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteAnnotation: (id: number) =>
    jsonRequest<void>(`/api/annotations/${id}`, { method: "DELETE" }),

  createAttribute: (labelId: number, payload: AttributeCreate) =>
    jsonRequest<AttributeDefinition>(`/api/labels/${labelId}/attributes`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAttribute: (labelId: number, attrId: number, payload: AttributeUpdate) =>
    jsonRequest<AttributeDefinition>(`/api/labels/${labelId}/attributes/${attrId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteAttribute: (labelId: number, attrId: number) =>
    jsonRequest<void>(`/api/labels/${labelId}/attributes/${attrId}`, {
      method: "DELETE",
    }),

  searchDocument: (documentId: number, query: string, limit = 100) =>
    jsonRequest<SearchHit[]>(
      `/api/documents/${documentId}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  ollamaStatus: () => jsonRequest<OllamaStatus>("/api/ollama/status"),
  detectStructure: (documentId: number) =>
    jsonRequest<DetectStructureResponse>(
      `/api/documents/${documentId}/detect-structure`,
      { method: "POST" },
    ),
  suggestAttributes: (labelId: number, payload: SuggestAttributesIn) =>
    jsonRequest<SuggestAttributesOut>(
      `/api/labels/${labelId}/suggest-attributes`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  async uploadDocument(projectId: number, file: File): Promise<Document> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/projects/${projectId}/documents`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return res.json();
  },
};