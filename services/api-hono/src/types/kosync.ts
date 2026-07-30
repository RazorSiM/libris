export interface KosyncUserCreate {
  username: string;
  password: string;
}

export interface KosyncAuthResponse {
  authorized: "OK";
  userkey: string;
}

export interface KosyncProgressUpdate {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id?: string;
}

export interface KosyncProgressResponse {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id?: string;
  timestamp: number;
}
