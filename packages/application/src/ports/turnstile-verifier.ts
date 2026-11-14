export interface TurnstileVerifyInput {
  readonly token: string;
  readonly remoteIp: string | null;
  readonly action: string;
}

export interface TurnstileVerifier {
  verify(input: TurnstileVerifyInput): Promise<boolean>;
}
