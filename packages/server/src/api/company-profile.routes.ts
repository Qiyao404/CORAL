import type { FastifyInstance } from 'fastify';
import { getCompanyProfile, putCompanyProfile, resetCompanyProfile } from '../services/company-profile-service.js';

export function registerCompanyProfileRoutes(app: FastifyInstance) {
  app.get('/api/company-profile', async () => {
    return getCompanyProfile();
  });

  app.put('/api/company-profile', async (request, reply) => {
    const body = (request.body || {}) as any;
    if (!body.companyName || typeof body.companyName !== 'string') {
      return reply.status(400).send({ error: 'companyName 为必填字段' });
    }
    const updated = putCompanyProfile({
      companyName: body.companyName,
      industries: Array.isArray(body.industries) ? body.industries : [],
      coreBusinesses: Array.isArray(body.coreBusinesses) ? body.coreBusinesses : [],
      focusKeywords: Array.isArray(body.focusKeywords) ? body.focusKeywords : [],
      excludeKeywords: Array.isArray(body.excludeKeywords) ? body.excludeKeywords : [],
      policyTypes: {
        keep: Array.isArray(body?.policyTypes?.keep) ? body.policyTypes.keep : [],
        exclude: Array.isArray(body?.policyTypes?.exclude) ? body.policyTypes.exclude : [],
      },
      description: typeof body.description === 'string' ? body.description : '',
    });
    return updated;
  });

  app.post('/api/company-profile/reset', async () => {
    return resetCompanyProfile();
  });
}


// ── 个人画像（原公司画像升级，开源个人轻量级定位）──────────────────
import { getUserProfile, putUserProfile, resetUserProfile, userProfileToPrompt } from '../services/user-profile-service.js';

export function registerUserProfileRoutes(app: FastifyInstance) {
  app.get('/api/user-profile', async () => {
    return getUserProfile();
  });

  app.put('/api/user-profile', async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>;
    return putUserProfile(body);
  });

  app.post('/api/user-profile/reset', async () => {
    return resetUserProfile();
  });
}
