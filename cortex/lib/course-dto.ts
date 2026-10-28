import type { CourseConfig } from "@/lib/courses";
import type { DeclaredFormat } from "@/lib/exam-format";

/** Vue d'un cours exposée par /api/courses — jamais les chemins ni le propriétaire. */
export type CourseDto = {
  id: string;
  name: string;
  short: string;
  code: string;
  university: string;
  teachers: string[];
  language: string;
  examDate: string | null;
  durationMin: number;
  /** Format d'examen déclaré (null = rien de déclaré). */
  examFormat: DeclaredFormat | null;
  createdAt: string;
};

export function toDto(c: CourseConfig): CourseDto {
  return {
    id: c.id,
    name: c.name,
    short: c.short,
    code: c.examCode,
    university: c.university,
    teachers: c.profs,
    language: c.language,
    examDate: c.examDate ?? null,
    durationMin: c.durationMin,
    examFormat: c.examFormat,
    createdAt: c.createdAt,
  };
}
