export interface Identity {
  ownerType: string;
  ownerId: string;
  workspaces: IdentityWorkspace[];
}

export interface IdentityWorkspace {
  id: string;
  name: string;
}
