export interface ResumeContact {
  phone?: string;
  email?: string;
  location?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  website?: string;
  other?: (string | { text: string; url?: string })[];
}

export interface ResumeExperience {
  role: string;
  company?: string;
  location?: string;
  start?: string;
  end?: string;
  /** Used instead of start/end when given, e.g. "2023 – 2024". */
  dates?: string;
  /** Shown after the dates, e.g. "3 months". */
  duration?: string;
  /** Internship-only candidates are laid out as freshers. */
  internship?: boolean;
  bullets?: string[];
}

export interface ResumeProject {
  name?: string;
  description?: string;
  tech?: string | string[];
  link?: string;
}

export interface ResumeEducation {
  degree?: string;
  institution?: string;
  /** Year or status shown on the right, e.g. "2025" or "In Progress". */
  status?: string;
  grade?: string;
  details?: string[];
}

export interface ResumeData {
  name: string;
  title?: string;
  contact?: ResumeContact;
  summary?: string;
  experience?: ResumeExperience[];
  projects?: (ResumeProject | string)[];
  skills?: Record<string, string | string[]> | { label?: string; items: string | string[] }[];
  education?: ResumeEducation[];
  certifications?: string[];
  achievements?: string[];
  /** Any extra sections, appended at the end. */
  sections?: { title: string; bullets: string[] }[];
  /** Default: chosen automatically (experienced if there is a non-internship job, else fresher). */
  layout?: 'experienced' | 'fresher';
  /** Custom section order, e.g. ["summary", "education", "skills"]. */
  order?: string[];
  /** Override heading texts, e.g. { projects: "ACADEMIC PROJECTS" }. */
  titles?: Record<string, string>;
  /** "auto" (default) opens up the spacing of sparse resumes; "normal" always uses the reference spacing. */
  spacing?: 'auto' | 'normal';
}

export interface ResumeResult {
  pdf: Buffer;
  pages: number;
  layout: 'experienced' | 'fresher';
  warnings: string[];
  spacing: { mode: 'auto' | 'normal'; stretch: number; fill: number };
}

/** Builds a resume PDF in memory. Writes a file only when `output` is given. */
export function buildResume(data: ResumeData, options?: { output?: string }): ResumeResult;
