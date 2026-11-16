/**
 * SUPPRESSION D'UN COURS DU COMPTE PROPRIÉTAIRE — lib/course-deletion.ts
 * renvoie « passe par les scripts d'administration » pour ce compte ; c'est
 * ce script. Dry-run par défaut (rien n'est supprimé) ; --yes pour exécuter.
 * Refuse toujours les cours HISTORIQUES et un schéma partagé par une autre
 * ligne du registre (mêmes règles que lib/course-deletion, allowOwner ne
 * contourne QUE le refus propriétaire).
 *
 *   npm run course:delete -- --user <id ou email> --course <id>
 *   npm run course:delete -- --user <id ou email> --course <id> --yes
 *
 * Dans le conteneur prod (Railway) :
 *   railway ssh -- bash -lc "cd /app/cortex && npm run course:delete -- --user <id ou email> --course <id> --yes"
 */
import { deleteCourseWithData, describeDeletion, describePreview, previewCourseDeletion, resolveUserId } from "../lib/course-deletion";

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}

export type DeleteCourseArgs = { user?: string; course?: string; yes: boolean };

export async function runDeleteCourse(args: DeleteCourseArgs): Promise<string> {
  if (!args.user || !args.course) throw new Error("Usage : --user <id ou email> --course <id> [--yes]");
  const userId = await resolveUserId(args.user);
  if (!userId) throw new Error(`Utilisateur introuvable : ${args.user}`);
  if (!args.yes) return describePreview(userId, await previewCourseDeletion(userId, args.course));
  return describeDeletion(await deleteCourseWithData(userId, args.course, { allowOwner: true }));
}

if (process.argv[1]?.endsWith("delete-course.ts")) {
  (async () => {
    console.log(await runDeleteCourse({ user: arg("user"), course: arg("course"), yes: process.argv.includes("--yes") }));
    process.exit(0);
  })().catch((e) => { console.error("[course:delete] échec :", (e as Error)?.message ?? e); process.exit(1); });
}
