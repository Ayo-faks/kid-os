export interface ResidentResponse {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredName: string | null;
  readonly dateOfBirth: string;
  readonly arrivedAt: string;
  readonly leftAt: string | null;
}

export interface ListResidentsResponse {
  readonly items: readonly ResidentResponse[];
}
