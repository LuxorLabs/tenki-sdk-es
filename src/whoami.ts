export interface Identity {
  ownerType: string;
  ownerId: string;
  workspaces: IdentityWorkspace[];
}

export interface IdentityWorkspace {
  id: string;
  name: string;
  projects: IdentityProject[];
}

export interface IdentityProject {
  id: string;
  name: string;
}
