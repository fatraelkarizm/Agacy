import { expandAgentGraph } from "../../../../server/services/agent-graph";
import { agentGraphExpansionRequestSchema } from "../../../../server/schema/agent-graph.schema";

export async function POST(request: Request) {
  const parsed = agentGraphExpansionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid agent graph request" }, { status: 400 });
  }

  try {
    return Response.json(await expandAgentGraph(parsed.data));
  } catch {
    return Response.json(
      { error: "Agent graph expansion failed" },
      { status: 500 },
    );
  }
}
