import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Replis déterministes du plan de cours (sans LLM).
 * 1. Titre : lu sur la page de garde seule. Lire les pages 1-3 jointes faisait déborder le titre
 *    sur la page 2 (cas réel ML du 18/09 : « Introduction 1 General organization: People… »).
 * 2. Rattachement : chaque notion va au chapitre de la lecture modale de ses exos indexés.
 */

const ML_GARDE_L1 = "CS 233—Introduction to Machine Learning Lecture 1: Introduction 1";
const ML_PAGE2_L1 =
  "General organization: People • Lecturer: Mathieu Salzmann • Teaching Assistants: • Malo Perez • Yann Bouquet 2";
const ML_GARDE_L10 = "CS 233—Introduction to Machine Learning Lecture 10: Deep Learning (Part 2) 1";

test("titre de lecture : la page de garde seule donne le titre exact du prof", async () => {
  const { seedLectureTitle } = await import("../lib/course-plan");
  const joined = `${ML_GARDE_L1} ${ML_PAGE2_L1}`;
  assert.deepEqual(seedLectureTitle(ML_GARDE_L1, joined, 1), { no: 1, title: "Introduction" });
  assert.deepEqual(seedLectureTitle(ML_GARDE_L10, ML_GARDE_L10, 10), { no: 10, title: "Deep Learning (Part 2)" });
});

test("titre de lecture : sans titre sur la garde, repli sur les pages jointes (jamais inventé)", async () => {
  const { seedLectureTitle } = await import("../lib/course-plan");
  const joined = `Slides imprimées. ${ML_GARDE_L10}`;
  assert.equal(seedLectureTitle("Slides imprimées.", joined, 10).title, "Deep Learning (Part 2)");
  assert.equal(seedLectureTitle("", "", 3).title, null);
});

test("rattachement : lecture modale des exos, égalité → la plus précoce, lecture hors plan → non rattachée", async () => {
  const { mapTopicsByIndexedLectures } = await import("../lib/course-plan");
  const href = (n: number, page = 1) => `/csrc?course=ml&p=slides%2Flecture_${n}.pdf#page=${page}`;
  const chapters = new Map([[2, 102], [5, 105], [7, 107]]); // lecture → id de chapitre
  const map = mapTopicsByIndexedLectures(
    [
      { topicId: 1, courseHref: href(5) }, { topicId: 1, courseHref: href(5, 9) }, { topicId: 1, courseHref: href(2) },
      { topicId: 2, courseHref: href(7) }, { topicId: 2, courseHref: href(2) }, // égalité 7/2 → 2
      { topicId: 3, courseHref: href(12) }, // lecture 12 absente du plan
      { topicId: 4, courseHref: null }, // aucun passage de cours
    ],
    chapters
  );
  assert.equal(map.get(1), 105);
  assert.equal(map.get(2), 102);
  assert.equal(map.has(3), false);
  assert.equal(map.has(4), false);
});

test("clé d'ordre de cours : la lecture se lit dans le deep-link", async () => {
  const { lectureOfCourseHref, courseOrderKey } = await import("../lib/course-order");
  assert.equal(lectureOfCourseHref("/csrc?course=ml&p=slides%2Flecture_12.pdf#page=31"), 12);
  assert.equal(courseOrderKey("/csrc?course=ml&p=slides%2Flecture_12.pdf#page=31"), 1_200_031);
  assert.equal(lectureOfCourseHref("/csrc?course=ml&p=refs%2Fexam.pdf#page=3"), null);
  assert.equal(lectureOfCourseHref(null), null);
  // compatibilité : lib/program réexporte toujours courseOrderKey
  const program = await import("../lib/program");
  assert.equal(program.courseOrderKey, courseOrderKey);
});
