import { currentCourse } from "@/db/client";
import { coursePaths } from "@/lib/courses";

/**
 * Dossiers de données SCOPÉS au cours courant.
 * cs-202 → exactement data/exams, data/uploads, data/refs, racine du repo (byte-identique à avant).
 * autres cours → data/<id>/{exams,uploads,refs} et data/<id>/content.
 */
export const examsDir = () => coursePaths(currentCourse()).examsDir;
export const uploadsDir = () => coursePaths(currentCourse()).uploadsDir;
export const refsDir = () => coursePaths(currentCourse()).refsDir;
export const contentRoot = () => coursePaths(currentCourse()).contentRoot;
