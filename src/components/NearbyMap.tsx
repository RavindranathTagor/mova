import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletPoint } from '../location.mjs';

type Point={latitude:number;longitude:number};
type NearbyPlace={id:string;name:string;address?:string;location:Point;distanceMeters:number};
export default function NearbyMap({center,places,radiusMeters,tileUrl='https://tile.openstreetmap.org/{z}/{x}/{y}.png'}:{center:Point;places:NearbyPlace[];radiusMeters:number;tileUrl?:string}){
  const host=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!host.current)return;
    const origin=leafletPoint(center);
    const map=L.map(host.current,{zoomControl:true,attributionControl:true,scrollWheelZoom:false}).setView(origin,14);
    L.tileLayer(tileUrl,{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
    const bounds=L.latLngBounds([]);
    const radius=L.circle(origin,{radius:radiusMeters,color:'#3467c9',weight:1,fillColor:'#7ea3df',fillOpacity:.08}).addTo(map);bounds.extend(radius.getBounds());
    const user=L.circleMarker(origin,{radius:8,color:'#fff',weight:3,fillColor:'#3467c9',fillOpacity:1}).addTo(map);
    user.bindTooltip('Search location');
    for(const place of places){
      const marker=L.circleMarker(leafletPoint(place.location),{radius:7,color:'#fff',weight:2,fillColor:'#347b57',fillOpacity:1}).addTo(map);
      const popup=document.createElement('div');const title=document.createElement('strong');title.textContent=place.name;popup.append(title);
      if(place.address){const address=document.createElement('div');address.textContent=place.address;popup.append(address);}
      const distance=document.createElement('div');distance.textContent=place.distanceMeters<1000?`${place.distanceMeters} m away`:`${(place.distanceMeters/1000).toFixed(1)} km away`;popup.append(distance);marker.bindPopup(popup);bounds.extend(marker.getLatLng());
    }
    if(bounds.isValid())map.fitBounds(bounds,{padding:[32,32],maxZoom:16});
    const resize=new ResizeObserver(()=>map.invalidateSize({pan:false}));resize.observe(host.current);
    return()=>{resize.disconnect();map.remove();};
  },[center.latitude,center.longitude,places,radiusMeters,tileUrl]);
  return <div className="nearby-map" ref={host} role="img" aria-label="Map of the search location and nearby places"/>;
}
