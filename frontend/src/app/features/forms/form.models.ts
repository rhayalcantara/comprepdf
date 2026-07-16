import {
  FormColumns,
  FormDefinition,
  FormQuestion,
  FormQuestionType,
  FormSection,
} from '../../core/services/api.service';

export type {
  FormColumns,
  FormDefinition,
  FormQuestion,
  FormQuestionType,
  FormSection,
  FormSummary,
} from '../../core/services/api.service';

/** Máximo de columnas por sección. Espejo del backend y del worker. */
export const MAX_COLUMNS = 3;

/** crypto.randomUUID solo existe en contextos seguros (HTTPS/localhost); QA se sirve por HTTP. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tipos de pregunta con su etiqueta en español para el selector del editor. */
export const QUESTION_TYPES: { value: FormQuestionType; label: string }[] = [
  { value: 'short_text', label: 'Texto corto' },
  { value: 'long_text', label: 'Texto largo' },
  { value: 'number', label: 'Número' },
  { value: 'date', label: 'Fecha' },
  { value: 'checkbox', label: 'Casilla' },
  { value: 'radio', label: 'Selección única' },
  { value: 'select', label: 'Lista desplegable' },
];

/** Definición inicial de un formulario nuevo (borrador de ejemplo). */
export function createForm(): FormDefinition {
  return {
    id: newId(),
    name: 'Solicitud de servicio',
    description: 'Formulario creado con ComprePDF.',
    page_size: 'letter',
    header: {
      title: 'Solicitud de servicio',
      subtitle: 'Complete los campos indicados antes de enviar el documento.',
    },
    footer: {
      text: 'Información de uso interno',
      show_page_numbers: true,
    },
    sections: [
      {
        ...createSection('Datos de la solicitud'),
        questions: [
          createQuestion('short_text', 1, 'Nombre completo'),
          createQuestion('checkbox', 2, 'Confirmo que los datos son correctos'),
          {
            ...createQuestion('radio', 3, 'Prioridad de la solicitud'),
            options: ['Normal', 'Urgente'],
          },
        ],
      },
    ],
  };
}

export function createSection(title = ''): FormSection {
  return {
    id: newId(),
    title,
    columns: 1,
    page_break: false,
    questions: [],
  };
}

export function createQuestion(
  type: FormQuestionType,
  position: number,
  label = 'Nueva pregunta',
): FormQuestion {
  return {
    id: newId(),
    name: `campo_${position}`,
    type,
    label,
    help_text: '',
    required: false,
    options: type === 'radio' || type === 'select' ? ['Opción 1', 'Opción 2'] : [],
    column_span: 1,
  };
}

function clampColumns(value: unknown): FormColumns {
  const columns = Math.trunc(Number(value));
  if (!Number.isFinite(columns) || columns < 1) return 1;
  return Math.min(columns, MAX_COLUMNS) as FormColumns;
}

/**
 * Deja una definición lista para editar.
 *
 * `GET /forms/:id` devuelve el payload tal cual está en la base de datos, sin
 * validar ni normalizar, así que un formulario creado antes de las secciones
 * llega con `questions` plano y sin `sections`: hay que envolverlo aquí o el
 * editor no sabría dibujarlo. También descarta el espejo plano para que sea
 * imposible editar el dato muerto.
 */
export function normalizeDefinition(raw: FormDefinition): FormDefinition {
  const sections = Array.isArray(raw.sections) && raw.sections.length
    ? raw.sections.map(normalizeSection)
    : [{ ...createSection(), questions: (raw.questions ?? []).map((q) => normalizeQuestion(q, 1)) }];

  const definition: FormDefinition = { ...raw, sections };
  delete definition.questions;
  return definition;
}

function normalizeSection(section: FormSection): FormSection {
  const columns = clampColumns(section.columns);
  return {
    ...section,
    id: section.id || newId(),
    title: section.title ?? '',
    columns,
    page_break: section.page_break ?? false,
    questions: (section.questions ?? []).map((q) => normalizeQuestion(q, columns)),
  };
}

function normalizeQuestion(question: FormQuestion, columns: number): FormQuestion {
  const span = Math.trunc(Number(question.column_span));
  return {
    ...question,
    id: question.id || newId(),
    options: question.options ?? [],
    column_span: Number.isFinite(span) && span >= 1 ? Math.min(span, columns) : 1,
  };
}
