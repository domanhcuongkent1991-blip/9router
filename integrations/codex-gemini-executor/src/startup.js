export async function prepareGeminiJob({ request, validateRequest, compatibilityAdapter, acquireWorkspaceLease }) {
  const validatedRequest = await validateRequest(request);
  const compatibility = await compatibilityAdapter.check();
  const workspaceLease = await acquireWorkspaceLease(validatedRequest);
  return Object.freeze({ request: validatedRequest, compatibility, workspaceLease });
}
