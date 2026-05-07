export type LiveEventConnectionStatus = "connecting" | "open" | "closed" | "error";

export interface LiveEventSignal {
  id: string;
  eventEntityId: string;
  eventType: string;
  canonicalName: string;
  timestamp: string;
  confidence: number;
  sourceBatchId: string;
  receivedAt: string;
}

export type ConnectedEntityKind = "ORG" | "PERSON" | "GEO";

export interface ConnectedEntity {
  id: string;
  entityType: ConnectedEntityKind;
  canonicalName: string;
  confidence: number | null;
  lastUpdated: string | null;
}

export interface GeoLocationEntity {
  id: string;
  canonicalName: string;
  confidence: number | null;
  sourceCount: number | null;
  lastUpdated: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GeoConnectedGraphEntity {
  id: string;
  entityType: "ORG" | "PERSON";
  canonicalName: string;
  confidence: number | null;
  lastUpdated: string | null;
}

export interface GeoRelationshipEdge {
  id: string;
  sourceEntityId: string | null;
  destinationEntityId: string | null;
  confidence: number | null;
  validFrom: string | null;
  evidenceText: string | null;
}

export interface GeoGraph {
  generatedAt: string;
  limit: number;
  locations: GeoLocationEntity[];
  connectedEntities: GeoConnectedGraphEntity[];
  relationships: GeoRelationshipEdge[];
}

