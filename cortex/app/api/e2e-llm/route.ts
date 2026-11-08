import { NextResponse } from "next/server";

export async function POST(req: Request) {
  if (process.env.E2E_TEST_RUN !== "1" || process.env.E2E_TEST_AUTH !== "1") return new NextResponse("Not found", { status: 404 });
  const body = await req.json() as { response_format?: { json_schema?: { schema?: Record<string, unknown> } } };
  const schema = body.response_format?.json_schema?.schema;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const content = schema
    ? JSON.stringify(required.includes("criteria")
      ? { verdict: "wrong", feedback: "Le calcul doit utiliser une primitive.", correct_solution: "L'intégrale vaut 1/2.", criteria: [
          { label: "Choisir une primitive", points: 1, achieved: false, essential: true, justification: "La primitive manque." },
          { label: "Évaluer aux bornes", points: 1, achieved: false, essential: false, justification: "Les bornes ne sont pas évaluées." },
        ] }
      : { concept: "Intégrales", statement_html: "<p>Calcule ∫₀¹ x dx.</p>", hints: ["Cherche une primitive", "Utilise x²/2", "Évalue aux bornes", "Soustrais", "Le résultat vaut 1/2"], solution_html: "<p>1/2</p>", course_terms: [] })
    : "Réponse hermétique E2E";
  return NextResponse.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
}
