import { NotFound } from '@curveball/http-errors';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import db from '../database';
import * as UserService from '../user/service';
import { User } from '../user/types';
import { InvalidRequest, UnauthorizedClient } from './errors';
import { OAuth2Client, OAuth2Code, OAuth2Token } from './types';

// 10 minutes
const ACCESS_TOKEN_EXPIRY = 600;

// 1 hour
const REFRESH_TOKEN_EXPIRY = 3600;

// 10 minutes
const CODE_EXPIRY = 600;

export async function getClientByClientId(clientId: string): Promise<OAuth2Client> {

  const query = 'SELECT id, client_id, client_secret, user_id FROM oauth2_clients WHERE client_id = ?';
  const result = await db.query(query, [clientId]);

  if (!result[0].length) {
    throw new NotFound('OAuth2 client_id not recognized');
  }

  return {
    id: result[0][0].id,
    clientId: result[0][0].client_id,
    clientSecret: result[0][0].client_secret,
    userId: result[0][0].user_id,
  };

}

export async function validateSecret(oauth2Client: OAuth2Client, secret: string): Promise<boolean> {

  return await bcrypt.compare(secret, oauth2Client.clientSecret.toString('utf-8'));

}

export async function validateRedirectUri(client: OAuth2Client, redirectUrl: string) {

  const query = 'SELECT id FROM oauth2_redirect_uris WHERE oauth2_client_id = ? AND uri = ?';
  const result = await db.query(query, [client.id, redirectUrl]);

  return result[0].length > 0;

}

/**
 * This function is used for the implicit grant oauth2 flow.
 *
 * This function creates an access token for a specific user.
 */
export async function generateTokenForUser(client: OAuth2Client, user: User): Promise<OAuth2Token> {

  const accessToken = crypto.randomBytes(32).toString('base64').replace('=', '');
  const refreshToken = crypto.randomBytes(32).toString('base64').replace('=', '');

  const query = 'INSERT INTO oauth2_tokens SET created = UNIX_TIMESTAMP(), ?';

  const accessTokenExpires = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRY;
  const refreshTokenExpires = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY;

  await db.query(query, {
    oauth2_client_id: client.id,
    access_token: accessToken,
    refresh_token: refreshToken,
    user_id: user.id,
    access_token_expires: accessTokenExpires,
    refresh_token_expires: refreshTokenExpires,
  });

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    accessTokenExpires: accessTokenExpires,
    tokenType: 'bearer',
    userId: user.id,
  };

}

/**
 * This function is used for the client_credentials oauth2 flow.
 *
 * In this flow there is not a 3rd party (resource owner). There is simply 2
 * clients talk to each other.
 *
 * The client acts on behalf of itself, not someone else.
 */
export async function generateTokenForClient(client: OAuth2Client): Promise<OAuth2Token> {

  const accessToken = crypto.randomBytes(32).toString('base64').replace('=', '');
  const refreshToken = crypto.randomBytes(32).toString('base64').replace('=', '');

  const query = 'INSERT INTO oauth2_tokens SET created = UNIX_TIMESTAMP(), ?';

  const accessTokenExpires = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRY;
  const refreshTokenExpires = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_EXPIRY;

  await db.query(query, {
    oauth2_client_id: client.id,
    access_token: accessToken,
    refresh_token: refreshToken,
    user_id: client.userId,
    access_token_expires: accessTokenExpires,
    refresh_token_expires: refreshTokenExpires,
  });

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    accessTokenExpires: accessTokenExpires,
    tokenType: 'bearer',
    userId: client.userId,
  };

}

/**
 * This function is used for the authorization_code oauth2 flow.
 *
 * In this flow a user first authenticates itself and grants permisssion to
 * the client. After gaining permission the user gets redirected back to the
 * resource owner with a one-time code.
 *
 * The resource owner then exchanges that code for an access and refresh token.
 */
export async function generateTokenFromCode(client: OAuth2Client, code: string): Promise<OAuth2Token> {

  const query = 'SELECT * FROM oauth2_codes WHERE code = ?';
  const codeResult = await db.query(query, [code]);

  if (!codeResult[0].length) {
    throw new InvalidRequest('The supplied code was not recognized');
  }

  const codeRecord: OAuth2CodeRecord = codeResult[0][0];

  // Delete immediately.
  await db.query('DELETE FROM oauth2_codes WHERE id = ?', [codeRecord.id]);

  if (codeRecord.created + CODE_EXPIRY < Math.floor(Date.now() / 1000)) {
    throw new InvalidRequest('The supplied code has expired');
  }
  if (codeRecord.client_id !== client.id) {
    throw new UnauthorizedClient('The client_id associated with the token did not match with the authenticated client credentials');
  }

  const user = await UserService.findById(codeRecord.user_id);
  return generateTokenForUser(client, user);

}

/**
 * This function is used for the authorization_code grant flow.
 *
 * This function creates an code for a user. The code is later exchanged for
 * a oauth2 access token.
 */
export async function generateCodeForUser(client: OAuth2Client, user: User): Promise<OAuth2Code> {

  const code = crypto.randomBytes(32).toString('base64').replace('=', '');

  const query = 'INSERT INTO oauth2_codes SET created = UNIX_TIMESTAMP(), ?';

  await db.query(query, {
    client_id: client.id,
    user_id: user.id,
    code: code,
  });

  return {
    code: code
  };

}

type OAuth2TokenRecord = {
  oauth2_client_id: number,
  access_token: string,
  refresh_token: string,
  user_id: number,
  access_token_expires: number,
  refresh_token_expires: number
};

type OAuth2CodeRecord = {
  id: number,
  client_id: number,
  code: string,
  user_id: number,
  created: number,
};

/**
 * Returns Token information for an existing Access Token.
 *
 * This effectively gives you all information of an access token if you have
 * just the bearer, and allows you to validate if a bearer token is valid.
 *
 * This function will throw NotFound if the token was not recognized.
 */
export async function getTokenByAccessToken(accessToken: string): Promise<OAuth2Token> {

  const query = `
  SELECT
   oauth2_client_id,
   access_token,
   refresh_token,
   user_id,
   access_token_expires,
   refresh_token_expires
  FROM oauth2_tokens
  WHERE
    access_token = ? AND
    access_token_expires > UNIX_TIMESTAMP()
  `;

  const result = await db.query(query, [accessToken]);
  if (!result[0].length) {
    throw new NotFound('Access token not recognized');
  }

  const row: OAuth2TokenRecord = result[0][0];
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpires: row.access_token_expires,
    tokenType: 'bearer',
    userId: row.user_id,
  };

}
