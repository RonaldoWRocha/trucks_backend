export type AuthContext = {
  userId: number;
  clientId: number;
  schemaName: string;
  role: string;
  isPlatformAdmin: boolean;
};

export type RequestWithAuth = {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
};
