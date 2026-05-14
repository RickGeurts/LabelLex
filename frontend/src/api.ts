import type {
  Annotation,
  AnnotationCreate,
  AnnotationRelation,
  AnnotationRelationCreate,
  AnnotationUpdate,
  AttributeCreate,
  AttributeDefinition,
  AttributeUpdate,
  DetectStructureResponse,
  Document,
  DocumentCategory,
  DocumentCategoryCreate,
  DocumentCategoryUpdate,
  DocumentUpdate,
  Label,
  LabelCreate,
  LabelUpdate,
  LlmProvidersStatus,
  OllamaStatus,
  Page,
  PrelabelCIRequest,
  PrelabelEvent,
  PrelabelRequest,
  Project,
  ProjectCreate,
  RelationDefinition,
  RelationDefinitionCreate,
  RelationDefinitionUpdate,
  SearchHit,
  SuggestAttributesIn,
  SuggestAttributesOut,
  SuggestionListItem,
  TncRange,
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

async function streamNdjson<TBody, TEvent>(
  url: string,
  body: TBody,
  onEvent: (e: TEvent) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  if (!res.body) throw new Error("Stream not supported by this browser");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as TEvent);
    }
  }
  const tail = buf.trim();
  if (tail) onEvent(JSON.parse(tail) as TEvent);
}

export const api = {
  listProjects: () => jsonRequest<Project[]>("/api/projects"),
  createProject: (payload: ProjectCreate) =>
    jsonRequest<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteProject: (id: number) =>
    jsonRequest<void>(`/api/projects/${id}`, { method: "DELETE" }),
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
  updateDocument: (id: number, payload: DocumentUpdate) =>
    jsonRequest<Document>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteDocument: (id: number) =>
    jsonRequest<void>(`/api/documents/${id}`, { method: "DELETE" }),

  listCategories: (projectId: number) =>
    jsonRequest<DocumentCategory[]>(
      `/api/projects/${projectId}/categories`,
    ),
  createCategory: (projectId: number, payload: DocumentCategoryCreate) =>
    jsonRequest<DocumentCategory>(`/api/projects/${projectId}/categories`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateCategory: (categoryId: number, payload: DocumentCategoryUpdate) =>
    jsonRequest<DocumentCategory>(`/api/categories/${categoryId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteCategory: (categoryId: number) =>
    jsonRequest<void>(`/api/categories/${categoryId}`, { method: "DELETE" }),

  listRelationDefs: (projectId: number) =>
    jsonRequest<RelationDefinition[]>(
      `/api/projects/${projectId}/relation-defs`,
    ),
  createRelationDef: (projectId: number, payload: RelationDefinitionCreate) =>
    jsonRequest<RelationDefinition>(
      `/api/projects/${projectId}/relation-defs`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  updateRelationDef: (defId: number, payload: RelationDefinitionUpdate) =>
    jsonRequest<RelationDefinition>(`/api/relation-defs/${defId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteRelationDef: (defId: number) =>
    jsonRequest<void>(`/api/relation-defs/${defId}`, { method: "DELETE" }),

  listDocumentRelations: (documentId: number) =>
    jsonRequest<AnnotationRelation[]>(
      `/api/documents/${documentId}/relations`,
    ),
  createRelation: (payload: AnnotationRelationCreate) =>
    jsonRequest<AnnotationRelation>("/api/relations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteRelation: (id: number) =>
    jsonRequest<void>(`/api/relations/${id}`, { method: "DELETE" }),
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
  prelabelDocumentStream: async (
    documentId: number,
    payload: PrelabelRequest,
    onEvent: (e: PrelabelEvent) => void,
  ): Promise<void> => streamNdjson(
    `/api/documents/${documentId}/prelabel`,
    payload,
    onEvent,
  ),
  getTncRanges: (documentId: number) =>
    jsonRequest<TncRange[]>(`/api/documents/${documentId}/tnc-ranges`),
  getLlmProviders: () =>
    jsonRequest<LlmProvidersStatus>("/api/llm-providers"),
  prelabelClausesInstrumentsStream: async (
    documentId: number,
    payload: PrelabelCIRequest,
    onEvent: (e: PrelabelEvent) => void,
  ): Promise<void> => streamNdjson(
    `/api/documents/${documentId}/prelabel-clauses-instruments`,
    payload,
    onEvent,
  ),
  listDocumentSuggestions: (documentId: number, status: string = "pending") =>
    jsonRequest<SuggestionListItem[]>(
      `/api/documents/${documentId}/suggestions?status=${encodeURIComponent(status)}`,
    ),
  acceptSuggestion: (suggestionId: number) =>
    jsonRequest<Annotation>(`/api/suggestions/${suggestionId}/accept`, {
      method: "POST",
    }),
  rejectSuggestion: (suggestionId: number) =>
    jsonRequest<void>(`/api/suggestions/${suggestionId}/reject`, {
      method: "POST",
    }),

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
  publishToLoraForge: (projectId: number) =>
    jsonRequest<{
      ok: boolean;
      loraForgeUrl: string;
      dataset: { id: string; name: string; rowCount: number };
      summary: {
        totalDocuments: number;
        documentsWithLabels: number;
        annotations: number;
      };
    }>(`/api/projects/${projectId}/publish-to-lora-forge`, { method: "POST" }),
};