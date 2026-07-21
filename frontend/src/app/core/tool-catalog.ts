// Catálogo único de herramientas: alimenta el grid del home y las páginas de
// cada operación. Cada herramienta tiene su propio matiz para el chip de ícono.
export interface ToolDef {
  id: string;
  route: string;
  icon: string;
  title: string;
  description: string;
  /** Color del ícono */
  hue: string;
  /** Fondo suave del chip */
  hueSoft: string;
  /** Texto del botón de acción en su página */
  cta: string;
}

export const TOOL_CATALOG: ToolDef[] = [
  {
    id: 'compress',
    route: '/compress',
    icon: 'compress',
    title: 'Comprimir',
    description: 'Reduce el tamaño de un PDF eligiendo el nivel de calidad.',
    hue: '#2e5bff',
    hueSoft: '#eaefff',
    cta: 'Comprimir PDF',
  },
  {
    id: 'split',
    route: '/tools/split',
    icon: 'content_cut',
    title: 'Dividir',
    description: 'Separa un PDF en páginas sueltas o por rangos, en un ZIP.',
    hue: '#7c3aed',
    hueSoft: '#f1eafd',
    cta: 'Dividir PDF',
  },
  {
    id: 'merge',
    route: '/tools/merge',
    icon: 'merge_type',
    title: 'Unir',
    description: 'Combina varios PDFs en un solo documento, en el orden que elijas.',
    hue: '#0e7490',
    hueSoft: '#e0f4f8',
    cta: 'Unir PDFs',
  },
  {
    id: 'sign',
    route: '/tools/sign',
    icon: 'history_edu',
    title: 'Firmar',
    description: 'Firma con certificado digital, dibuja tu firma, o ambas.',
    hue: '#b45309',
    hueSoft: '#fdf1e0',
    cta: 'Firmar PDF',
  },
  {
    id: 'extract',
    route: '/tools/extract',
    icon: 'find_in_page',
    title: 'Extraer páginas',
    description: 'Crea un PDF nuevo solo con las páginas que indiques.',
    hue: '#059669',
    hueSoft: '#e7f6f0',
    cta: 'Extraer páginas',
  },
  {
    id: 'rotate',
    route: '/tools/rotate',
    icon: 'rotate_right',
    title: 'Rotar',
    description: 'Gira todas las páginas o solo algunas, 90°, 180° o 270°.',
    hue: '#db2777',
    hueSoft: '#fceaf2',
    cta: 'Rotar páginas',
  },
  {
    id: 'organize',
    route: '/organizar',
    icon: 'dashboard_customize',
    title: 'Ordenar páginas',
    description: 'Reordena, elimina o gira páginas arrastrando sus miniaturas.',
    hue: '#6d28d9',
    hueSoft: '#f0eafc',
    cta: 'Ordenar páginas',
  },
  {
    id: 'protect',
    route: '/tools/protect',
    icon: 'lock',
    title: 'Proteger',
    description: 'Añade una contraseña para restringir la apertura del PDF.',
    hue: '#dc2626',
    hueSoft: '#fdecec',
    cta: 'Proteger PDF',
  },
  {
    id: 'unlock',
    route: '/tools/unlock',
    icon: 'lock_open',
    title: 'Desbloquear',
    description: 'Quita la contraseña de un PDF del que conoces la clave.',
    hue: '#4f46e5',
    hueSoft: '#ecebfd',
    cta: 'Desbloquear PDF',
  },
  {
    id: 'forms',
    route: '/formularios',
    icon: 'dynamic_form',
    title: 'Formularios',
    description: 'Diseña y genera formularios PDF rellenables (AcroForm).',
    hue: '#0d9488',
    hueSoft: '#e0f5f2',
    cta: 'Crear formulario',
  },
  {
    id: 'editor',
    route: '/editor',
    icon: 'edit_document',
    title: 'Editar PDF',
    description: 'Añade texto o imágenes sobre el PDF, o tapa lo que quieras cambiar.',
    hue: '#ea580c',
    hueSoft: '#fdece1',
    cta: 'Editar PDF',
  },
];

export function findTool(id: string): ToolDef | undefined {
  return TOOL_CATALOG.find((t) => t.id === id);
}
