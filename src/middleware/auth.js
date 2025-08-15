import bcrypt from 'bcrypt';

export const hashPassword = async password => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

export const verifyPassword = async (password, hash) => await bcrypt.compare(password, hash);

export const authenticate = async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.warn('JWT verification failed:', err.message);
    throw reply.unauthorized('Authentication required');
  }
};

export const authorize = (...allowedRoles) => {
  return async (request, reply) => {
    await authenticate(request, reply);
    const userRole = request.user.role;
    if (!allowedRoles.includes(userRole)) {
      throw reply.forbidden(`Access denied. Required roles: ${allowedRoles.join(', ')}`);
    }
  };
};

export const canManageUsers = authorize('ADMIN', 'MANAJER');
export const requireAdmin = authorize('ADMIN');
export const requireAdminOrManager = authorize('ADMIN', 'MANAJER');

export const checkNotDeleted = entity => {
  if (entity && entity.deletedAt) throw new Error('Resource has been deleted');
  return entity;
};

export const requireOwnerOrAdmin = async (request, reply) => {
  await authenticate(request, reply);
  const userRole = request.user.role;
  const userId = request.user.id;
  const targetUserId = request.params.id;
  if (userRole === 'ADMIN') return;
  if (userId !== targetUserId) throw reply.forbidden('You can only access your own resources');
};
