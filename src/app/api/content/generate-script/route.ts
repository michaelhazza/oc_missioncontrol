import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, description, platform = 'youtube', notes } = body;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    const litellmUrl = process.env.LITELLM_BASE_URL || 'http://localhost:4001/v1';
    const apiKey = process.env.LITELLM_API_KEY || 'sk-MnURELSoVB1esn-kPRDz2Q';

    const prompt = `You are a professional content creator. Write a complete, engaging script for the following piece of content.

Title: ${title}
Platform: ${platform}
${description ? `Description: ${description}` : ''}
${notes ? `Additional notes: ${notes}` : ''}

Write a full script with:
- A strong hook opening (first 15 seconds for video, or attention-grabbing first line)
- Clear sections/chapters
- Engaging storytelling
- A strong call to action at the end

Format the script clearly with section headers.`;

    const response = await fetch(`${litellmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        messages: [
          { role: 'user', content: prompt }
        ],
        max_tokens: 2000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('LiteLLM error:', errorText);
      return NextResponse.json({ error: 'Failed to generate script from LiteLLM' }, { status: 500 });
    }

    const data = await response.json();
    const script = data.choices?.[0]?.message?.content || '';

    return NextResponse.json({ script });
  } catch (error) {
    console.error('POST /api/content/generate-script error:', error);
    return NextResponse.json({ error: 'Failed to generate script' }, { status: 500 });
  }
}
