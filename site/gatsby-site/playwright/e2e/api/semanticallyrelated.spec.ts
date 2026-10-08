import { test, expect } from '@playwright/test';

test.describe('/api/semanticallyRelated endpoint', () => {
  test('Should get semantically related', async ({ request, baseURL }) => {
    const apiUrl = `${baseURL}/api/semanticallyRelated`;

    const response = await request.post(apiUrl, {
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      data: '{"text":"Child and consumer advocacy groups complained to the Federal Trade Commission Tuesday that Google’s new YouTube Kids app contains “inappropriate content,” including explicit sexual language and jokes about pedophilia. Google launched the app for young children in February, saying the available videos were “narrowed down to content appropriate for kids.”"}',
    });

    const responseBody = await response.json();

    expect(response.status()).toBe(200);
    expect(responseBody.embedding).toBeNull();
    expect(responseBody.incidents.length).toBeLessThanOrEqual(3);
    const scores = responseBody.incidents.map((incident: any) => {
      expect(Number.isSafeInteger(incident.incident_id)).toBe(true);
      expect(incident.similarity).toBeGreaterThanOrEqual(0.15);
      return incident.similarity;
    });
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
