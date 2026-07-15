import { FormDefinition, FormQuestion, FormQuestionType } from '../../core/services/api.service';

export type { FormDefinition, FormQuestion, FormQuestionType, FormSummary } from '../../core/services/api.service';

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
    id: crypto.randomUUID(),
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
    questions: [
      createQuestion('short_text', 1, 'Nombre completo'),
      createQuestion('checkbox', 2, 'Confirmo que los datos son correctos'),
      {
        ...createQuestion('radio', 3, 'Prioridad de la solicitud'),
        options: ['Normal', 'Urgente'],
      },
    ],
  };
}

export function createQuestion(
  type: FormQuestionType,
  position: number,
  label = 'Nueva pregunta',
): FormQuestion {
  return {
    id: crypto.randomUUID(),
    name: `campo_${position}`,
    type,
    label,
    help_text: '',
    required: false,
    options: type === 'radio' || type === 'select' ? ['Opción 1', 'Opción 2'] : [],
  };
}
